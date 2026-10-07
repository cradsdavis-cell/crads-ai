// main.swift: the Crads-AI window host for macOS (2026-10-07). The Windows twin
// is wizard/assets/win-host/host.cpp.
//
// Why it exists. On a Mac the dashboard used to be a Chrome `--app` window and
// the bundle's executable was the node server itself. A node process cannot
// own a window, a Dock icon or the "reopen" Apple Event, so every attempt to
// make that pair behave like an app traded one bug for another: with the
// server as the app, a second click did nothing until a force quit; with the
// server handing off and quitting (e1f28fe), the Dock showed Chrome instead of
// the leaf, "Keep in Dock" was never offered, and a second click opened a
// second window. This host is the bundle's executable now. It owns the window
// (WKWebView, so no browser is involved), and LaunchServices does the
// single-instance part for free: a second click reaches
// applicationShouldHandleReopen in THIS process, which brings the one window
// back instead of making another.
//
// The server is our child. We start Contents/MacOS/crads-ai (the SEA node
// binary, unchanged) with AIOS_WINDOW_HOST=1 and a pipe on its stdin that we
// never write to. It publishes {pid, url} in app.json, we load the url. When
// this process ends for any reason the pipe closes and the server exits with
// it: quitting the app quits the app. Closing the window does not.
//
// Updates: the server swaps the bundle and exits RESTART_EXIT. We wait until
// this process is gone (LaunchServices would otherwise just re-activate us,
// same bundle id) and open the bundle again, which is now the new version.
//
// Everything we do is logged to the same startup.log the server writes, with
// "window:" lines, so one file explains a launch end to end. CI asserts on them.
import Cocoa
import WebKit

let RESTART_EXIT: Int32 = 75       // twin of MAC_RESTART_EXIT in wizard/panel/updater.mjs
let APP_NAME = "Crads-AI"
let DOCS_URL = "https://crads-ai.com/docs"
let runDir = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Application Support/\(APP_NAME)", isDirectory: true)
let runFile = runDir.appendingPathComponent("app.json")
let logFile = runDir.appendingPathComponent("startup.log")

let stampFormat: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

func hostLog(_ msg: String) {
  let line = "\(stampFormat.string(from: Date())) [pid \(getpid()) window] window: \(msg)\n"
  guard let data = line.data(using: .utf8) else { return }
  FileHandle.standardError.write(data)
  try? FileManager.default.createDirectory(at: runDir, withIntermediateDirectories: true)
  if let h = try? FileHandle(forWritingTo: logFile) {
    h.seekToEndOfFile(); h.write(data); h.closeFile()
  } else {
    try? data.write(to: logFile)
  }
}

func isLoopback(_ url: URL) -> Bool {
  guard let h = url.host?.lowercased() else { return false }
  return h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]"
}

// `ps` instead of libproc: one less bridging surprise, and this runs once.
func commandLine(of pid: Int32) -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/ps")
  p.arguments = ["-o", "command=", "-p", String(pid)]
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return "" }
  p.waitUntilExit()
  let d = out.fileHandleForReading.readDataToEndOfFile()
  return String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func readRunFile() -> [String: Any]? {
  guard let d = try? Data(contentsOf: runFile),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
  return o
}

func htmlEscape(_ s: String) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}

// navigator.clipboard.writeText through the app, not WebKit. WebKit only lets a
// page write the clipboard inside a user gesture and an origin it trusts; the
// pages copy invite links, paths and the Slack manifest, and a copy button that
// silently does nothing is worse than none. The pasteboard write is ours.
let clipboardScript = """
(function(){
  try {
    var w = function(t){
      try { window.webkit.messageHandlers.cradsClipboard.postMessage(String(t)); return Promise.resolve(); }
      catch (e) { return Promise.reject(e); }
    };
    if (navigator.clipboard) { try { navigator.clipboard.writeText = w; } catch (e) {} }
    else { Object.defineProperty(navigator, 'clipboard', { value: { writeText: w }, configurable: true }); }
  } catch (e) {}
})();
"""

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
  WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

  var window: NSWindow!
  var web: WKWebView!
  var titleObservation: NSKeyValueObservation?
  var downloadHelper: AnyObject?

  var server: Process?
  var serverStdin: Pipe?
  var serverURL: URL?
  var doorURL: URL?
  var readyTimer: Timer?
  var readyDeadline = Date()
  var probing = false
  var pendingLinks: [URL] = []
  var firstPageLogged = false

  var quitting = false
  var restarting = false
  var retrying = false

  // MARK: launch

  func applicationDidFinishLaunching(_ note: Notification) {
    hostLog("host start (bundle=\(Bundle.main.bundlePath))")
    buildMenu()
    buildWindow()
    showStatusPage(starting: true, detail: nil)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    retireOldCopies()
    startServer()
  }

  // A copy of the app from before this host existed may still be running: the
  // detached server of build 24 and its Chrome --app window. Both belong to an
  // app that has been replaced; leaving them up means two dashboards, one of
  // them about to point at nothing. Only processes that are provably ours are
  // touched: the server by its bundle path, Chrome by its dedicated profile dir.
  func retireOldCopies() {
    if let o = readRunFile(), let pid = (o["pid"] as? NSNumber)?.int32Value, pid > 1, pid != getpid(), kill(pid, 0) == 0 {
      let cmd = commandLine(of: pid)
      if cmd.contains("/Contents/MacOS/crads-ai") && !cmd.contains("crads-ai-window") {
        kill(pid, SIGTERM)
        hostLog("retired an older server still running (pid \(pid))")
      }
    }
    try? FileManager.default.removeItem(at: runFile)
    let pk = Process()
    pk.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
    pk.arguments = ["-f", "Application Support/\(APP_NAME)/app-window-profile"]
    pk.standardOutput = FileHandle.nullDevice
    pk.standardError = FileHandle.nullDevice
    if (try? pk.run()) != nil {
      pk.waitUntilExit()
      if pk.terminationStatus == 0 { hostLog("closed an old browser app-window from before the native window") }
    }
  }

  // MARK: the server (our child)

  func startServer() {
    let exe = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/crads-ai")
    guard FileManager.default.isExecutableFile(atPath: exe.path) else {
      hostLog("server binary missing at \(exe.path)")
      showStatusPage(starting: false, detail: "The app's server is missing from the bundle. Download Crads-AI again from crads-ai.com.")
      return
    }
    let p = Process()
    p.executableURL = exe
    p.arguments = []
    var env = ProcessInfo.processInfo.environment
    env["AIOS_WINDOW_HOST"] = "1"
    env.removeValue(forKey: "AIOS_RELAUNCHED")
    p.environment = env
    let pipe = Pipe()
    p.standardInput = pipe
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    p.terminationHandler = { [weak self] proc in
      let status = proc.terminationStatus
      let signalled = proc.terminationReason == .uncaughtSignal
      DispatchQueue.main.async { self?.serverExited(status: status, signalled: signalled) }
    }
    do { try p.run() } catch {
      hostLog("server failed to start: \(error.localizedDescription)")
      showStatusPage(starting: false, detail: "The app's server could not start (\(error.localizedDescription)).")
      return
    }
    server = p
    serverStdin = pipe
    serverURL = nil
    hostLog("server spawned pid \(p.processIdentifier)")
    readyDeadline = Date().addingTimeInterval(60)
    readyTimer?.invalidate()
    readyTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.pollReady() }
  }

  // Ready = app.json names OUR child's pid AND its url answers. A file alone
  // only proves a process got far enough to write it.
  func pollReady() {
    guard let p = server, p.isRunning else { readyTimer?.invalidate(); return }
    if Date() > readyDeadline {
      readyTimer?.invalidate()
      hostLog("server pid \(p.processIdentifier) never answered within 60s")
      showStatusPage(starting: false, detail: "The app's server started but never answered.")
      return
    }
    if probing { return }
    guard let o = readRunFile(), let pid = (o["pid"] as? NSNumber)?.int32Value, pid == p.processIdentifier,
          let s = o["url"] as? String, let u = URL(string: s) else { return }
    let door = (o["door"] as? String).flatMap { URL(string: $0) }
    probing = true
    var req = URLRequest(url: u)
    req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.probing = false
        guard let h = resp as? HTTPURLResponse, h.statusCode < 500, self.serverURL == nil, self.server === p else { return }
        self.readyTimer?.invalidate()
        self.serverURL = u
        self.doorURL = door
        hostLog("server ready \(u.absoluteString)")
        self.web.load(URLRequest(url: u))
        self.flushLinks()
      }
    }.resume()
  }

  func serverExited(status: Int32, signalled: Bool) {
    readyTimer?.invalidate()
    let pid = server?.processIdentifier ?? 0
    server = nil
    serverStdin = nil
    serverURL = nil
    hostLog("server pid \(pid) exited \(signalled ? "on signal" : "with status") \(status)")
    if quitting || restarting { return }
    if retrying { retrying = false; startServer(); return }
    if !signalled && status == RESTART_EXIT {
      relaunchApp()
      return
    }
    showStatusPage(starting: false, detail: "The app's server stopped unexpectedly.")
    window.makeKeyAndOrderFront(nil)
  }

  // "Try again" on the status page and Reload with no server: whatever is
  // left of the old child goes first, so there is never a second one.
  func retryServer() {
    showStatusPage(starting: true, detail: nil)
    if let p = server, p.isRunning { retrying = true; p.terminate() } else { startServer() }
  }

  func stopServer() {
    guard let p = server, p.isRunning else { return }
    hostLog("stopping server pid \(p.processIdentifier)")
    p.terminate()
  }

  // An update put a new bundle where ours was. `open` on it while we are alive
  // only re-activates us (same bundle id), so a detached shell waits for this
  // pid to be gone and opens it then. Bundle.main.bundlePath is the path we
  // were launched from, which now holds the new version.
  func relaunchApp() {
    restarting = true
    let bundle = Bundle.main.bundlePath
    hostLog("update installed; relaunching \(bundle)")
    let sh = Process()
    sh.executableURL = URL(fileURLWithPath: "/bin/sh")
    sh.arguments = ["-c", "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$1\"", "sh", bundle]
    sh.standardInput = FileHandle.nullDevice
    sh.standardOutput = FileHandle.nullDevice
    sh.standardError = FileHandle.nullDevice
    do { try sh.run() } catch {
      hostLog("relaunch helper failed: \(error.localizedDescription)")
      restarting = false
      showStatusPage(starting: false, detail: "The update is installed. Quit Crads-AI and open it again to finish.")
      return
    }
    NSApp.terminate(nil)
  }

  // MARK: app lifecycle

  // The click on the Dock icon (or in Finder, Launchpad, Spotlight) while we
  // run. The one window comes back; there is never a second.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if flag {
      hostLog("reopen: window already open, brought forward")
    } else {
      hostLog("reopen: window shown")
      window.makeKeyAndOrderFront(nil)
    }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    quitting = true
    stopServer()
    return .terminateNow
  }

  func applicationWillTerminate(_ note: Notification) {
    hostLog(restarting ? "quitting for the update" : "quitting")
  }

  // crads-ai://box/<slug>: open that mineral. The door's /go/member route
  // starts the dashboard if it is not up and 302s to it; the fragment rides
  // the redirect and the page selects the box from it.
  func application(_ application: NSApplication, open urls: [URL]) {
    pendingLinks.append(contentsOf: urls.filter { $0.scheme?.lowercased() == "crads-ai" })
    window?.makeKeyAndOrderFront(nil)
    flushLinks()
  }

  func flushLinks() {
    guard let door = doorURL, serverURL != nil, !pendingLinks.isEmpty else { return }
    let links = pendingLinks
    pendingLinks = []
    for link in links {
      let parts = link.absoluteString.replacingOccurrences(of: "crads-ai://", with: "").split(separator: "/").map(String.init)
      guard parts.count >= 2, parts[0].lowercased() == "box",
            parts[1].range(of: "^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$", options: [.regularExpression, .caseInsensitive]) != nil
      else { hostLog("link ignored: \(link.absoluteString)"); continue }
      let slug = parts[1].lowercased()
      if let u = URL(string: "go/member?box=\(slug)#box=\(slug)", relativeTo: door) {
        hostLog("link: opening box \(slug)")
        web.load(URLRequest(url: u))
      }
    }
  }

  // MARK: window + webview

  func buildWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.preferences.javaScriptCanOpenWindowsAutomatically = true
    let ucc = WKUserContentController()
    ucc.add(self, name: "cradsClipboard")
    ucc.addUserScript(WKUserScript(source: clipboardScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    config.userContentController = ucc
    config.applicationNameForUserAgent = APP_NAME

    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 840), configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsMagnification = true
    web.autoresizingMask = [.width, .height]
    if #available(macOS 13.3, *) { web.isInspectable = true }

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 840),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = APP_NAME
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    window.minSize = NSSize(width: 640, height: 480)
    window.contentView = web
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("CradsAIMain")

    titleObservation = web.observe(\.title, options: [.new]) { [weak self] wv, _ in
      let t = wv.title ?? ""
      self?.window.title = t.isEmpty ? APP_NAME : t
    }
  }

  func showStatusPage(starting: Bool, detail: String?) {
    var icon = ""
    if let tiff = NSApp.applicationIconImage?.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
      icon = "<img src=\"data:image/png;base64,\(png.base64EncodedString())\" width=\"96\" height=\"96\" alt=\"\">"
    }
    let body: String
    if starting {
      body = "\(icon)<p class=\"t\">Starting \(APP_NAME)…</p>"
    } else {
      body = """
      \(icon)<p class="t">\(htmlEscape(detail ?? "Something went wrong."))</p>
      <p><a class="b" href="crads-host://retry">Try again</a> <a class="l" href="crads-host://logs">Show the log files</a></p>
      <p class="s">If it keeps happening, include the file called startup.log from that folder when you ask for help.</p>
      """
    }
    let html = """
    <!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
    html,body{height:100%;margin:0}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
      font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#1f2328;background:#fff;text-align:center;padding:0 32px}
    @media (prefers-color-scheme: dark){body{color:#e6edf3;background:#0d1117}}
    .t{font-size:17px;margin:18px 0 6px}.s{opacity:.65;font-size:13px}
    a.b{display:inline-block;padding:8px 16px;border-radius:8px;background:#2f6f4f;color:#fff;text-decoration:none;margin-right:12px}
    a.l{color:inherit}
    </style></head><body>\(body)</body></html>
    """
    web.loadHTMLString(html, baseURL: nil)
  }

  // Loopback pages load here. Anything else (docs, GitHub, sign-in pages,
  // Stripe) goes to the person's own browser: WebKit inside an app is not where
  // they are signed in, and Google refuses sign-in from embedded webviews.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    let scheme = url.scheme?.lowercased() ?? ""
    if scheme == "crads-host" {
      decisionHandler(.cancel)
      if url.host == "retry" { hostLog("retry clicked"); retryServer() }
      if url.host == "logs" { NSWorkspace.shared.activateFileViewerSelecting([logFile]) }
      return
    }
    if #available(macOS 11.3, *), action.shouldPerformDownload {
      decisionHandler(.download); return
    }
    if scheme == "about" || scheme == "data" || scheme == "blob" || isLoopback(url) {
      decisionHandler(.allow); return
    }
    if let frame = action.targetFrame, !frame.isMainFrame {
      decisionHandler(.allow); return              // an embedded frame, not a page change
    }
    decisionHandler(.cancel)
    hostLog("external link to the browser: \(url.scheme ?? "")://\(url.host ?? "")")
    NSWorkspace.shared.open(url)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    if #available(macOS 11.3, *) {
      var attachment = false
      if let h = response.response as? HTTPURLResponse,
         let cd = h.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
        attachment = true
      }
      if attachment || !response.canShowMIMEType { decisionHandler(.download); return }
    }
    decisionHandler(.allow)
  }

  @available(macOS 11.3, *)
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = downloads()
  }

  @available(macOS 11.3, *)
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = downloads()
  }

  @available(macOS 11.3, *)
  func downloads() -> DownloadHelper {
    if let d = downloadHelper as? DownloadHelper { return d }
    let d = DownloadHelper()
    downloadHelper = d
    return d
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let u = webView.url, isLoopback(u) else { return }
    if !firstPageLogged { firstPageLogged = true; hostLog("page loaded \(u.absoluteString)") }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    hostLog("web content process ended; reloading")
    if let u = serverURL { webView.load(URLRequest(url: u)) }
  }

  // target=_blank and window.open: the person's browser, like the Windows host.
  // The sign-in flows depend on this: the provider's page must open where the
  // person is signed in, and its redirect lands on our loopback server.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, let s = url.scheme?.lowercased(), s == "http" || s == "https" || s == "mailto" {
      hostLog("new window to the browser: \(s)://\(url.host ?? "")")
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    present(a) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    present(a) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = field
    present(a) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
  }

  func present(_ alert: NSAlert, then done: @escaping (NSApplication.ModalResponse) -> Void) {
    if window.isVisible {
      alert.beginSheetModal(for: window, completionHandler: done)
    } else {
      done(alert.runModal())
    }
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "cradsClipboard", let text = message.body as? String else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  // MARK: menu

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About \(APP_NAME)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide \(APP_NAME)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit \(APP_NAME)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    // Without these items Cmd-C / Cmd-V do nothing in a WKWebView: the key
    // equivalents travel through the main menu to the first responder.
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r").target = self
    view.addItem(.separator())
    view.addItem(withTitle: "Actual Size", action: #selector(zoomReset(_:)), keyEquivalent: "0").target = self
    view.addItem(withTitle: "Zoom In", action: #selector(zoomIn(_:)), keyEquivalent: "+").target = self
    view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut(_:)), keyEquivalent: "-").target = self
    view.addItem(.separator())
    let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fs.keyEquivalentModifierMask = [.command, .control]
    viewItem.submenu = view
    main.addItem(viewItem)

    let winItem = NSMenuItem()
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winItem.submenu = win
    main.addItem(winItem)
    NSApp.windowsMenu = win

    let helpItem = NSMenuItem()
    let help = NSMenu(title: "Help")
    help.addItem(withTitle: "\(APP_NAME) Docs", action: #selector(openDocs(_:)), keyEquivalent: "").target = self
    help.addItem(withTitle: "Show Log Files", action: #selector(showLogs(_:)), keyEquivalent: "").target = self
    helpItem.submenu = help
    main.addItem(helpItem)
    NSApp.helpMenu = help

    NSApp.mainMenu = main
  }

  @objc func reloadPage(_ sender: Any?) {
    if serverURL == nil { retryServer(); return }
    web.reload()
  }
  @objc func zoomReset(_ sender: Any?) { web.pageZoom = 1.0 }
  @objc func zoomIn(_ sender: Any?) { web.pageZoom = min(web.pageZoom + 0.1, 3.0) }
  @objc func zoomOut(_ sender: Any?) { web.pageZoom = max(web.pageZoom - 0.1, 0.5) }
  @objc func openDocs(_ sender: Any?) { if let u = URL(string: DOCS_URL) { NSWorkspace.shared.open(u) } }
  @objc func showLogs(_ sender: Any?) { NSWorkspace.shared.activateFileViewerSelecting([logFile]) }
}

// Downloads (an export, a file the box hands over) land in ~/Downloads under
// their own name, numbered if taken, and Finder shows them. Separate class so
// the 11.3-only protocol never gates the app delegate (the bundle says 11.0).
@available(macOS 11.3, *)
final class DownloadHelper: NSObject, WKDownloadDelegate {
  var destinations: [ObjectIdentifier: URL] = [:]

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
    let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var url = dir.appendingPathComponent(name)
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
      n += 1
    }
    destinations[ObjectIdentifier(download)] = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    if let url = destinations.removeValue(forKey: ObjectIdentifier(download)) {
      hostLog("download saved: \(url.lastPathComponent)")
      NSWorkspace.shared.activateFileViewerSelecting([url])
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    destinations.removeValue(forKey: ObjectIdentifier(download))
    hostLog("download failed: \(error.localizedDescription)")
    let a = NSAlert()
    a.messageText = "The download didn't finish."
    a.informativeText = error.localizedDescription
    a.runModal()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
