// host.cpp: the Crads-AI window host. A minimal Win32 + WebView2 shell whose ONLY
// job is owning the app window: when the UI ran inside `msedge --app=<url>` the
// window belonged to msedge.exe, so the taskbar/alt-tab showed Edge's icon no
// matter what favicon the pages served. This exe carries the Crads-AI icon in its
// resources (host.rc), so every surface that identifies the window by its process
// shows the brand. WebView2 (evergreen, ships with Win10/11) renders the page.
//
// Zero runtime deps beyond the OS: WebView2Loader is STATIC-linked, CRT is /MT.
// If the WebView2 runtime is somehow absent, environment creation fails and the
// process exits non-zero fast; app.mjs catches that and falls back to the old
// Edge/Chrome --app window, so the worst case is exactly yesterday's behaviour.
//
// Usage: crads-ai-window.exe <url>
//   --probe        print nothing, exit 0 iff the WebView2 runtime is resolvable
//                  (deterministic CI gate; no window, no GUI session needed)
//   --smoke <url>  open the window, close it after the first NavigationCompleted,
//                  exit 0 (30s watchdog exits 3). CI-only, non-fatal there.
//   (no url)       start Crads-AI.exe from this folder and exit: see the 2026-10-30
//                  note above LaunchApp.
#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <objbase.h>
#include <propsys.h>
#include <string>
#include <wrl.h>
#include "WebView2.h"
// initguid AFTER the other headers: it only has to define the PKEY_AppUserModel_*
// keys propkey.h declares (selectany, so no extra lib to link).
#include <initguid.h>
#include <propkey.h>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_webview;
static bool g_smoke = false;

// The app this host belongs to: Crads-AI.exe in the same folder (selfInstall
// writes both to %LOCALAPPDATA%\Programs\Crads-AI). Empty if it isn't there.
static std::wstring ExeDir() {
  wchar_t p[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH);
  if (!n || n >= MAX_PATH) return L"";
  std::wstring s(p, n);
  size_t slash = s.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"" : s.substr(0, slash + 1);
}
static std::wstring AppExe() {
  std::wstring dir = ExeDir();
  if (dir.empty()) return L"";
  std::wstring app = dir + L"Crads-AI.exe";
  return GetFileAttributesW(app.c_str()) == INVALID_FILE_ATTRIBUTES ? L"" : app;
}

// 2026-10-30 (a member's "black screen after restart"): the taskbar icon belongs
// to this exe, so pinning the running window pinned crads-ai-window-<tag>.exe
// with no url. Clicking the pin opened about:blank on the dark background: a
// black window with no app behind it, and nothing in startup.log because
// Crads-AI.exe never ran. So a launch with no url hands over to the app, which
// finds or starts the servers and reopens this host WITH a url, exactly like the
// Start menu shortcut does.
static bool LaunchApp(const std::wstring& app) {
  std::wstring cmd = L"\"" + app + L"\"";
  std::wstring dir = ExeDir();
  STARTUPINFOW si = { sizeof(si) };
  PROCESS_INFORMATION pi = {};
  if (!CreateProcessW(app.c_str(), &cmd[0], nullptr, nullptr, FALSE, 0, nullptr, dir.c_str(), &si, &pi)) return false;
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

// And new pins point at the app, not at this exe: the build-tagged host is swept
// after an update, so a pin to it would stop working altogether. These are the
// documented relaunch properties; Windows uses them only when ID, command and
// display name are all set.
static void PinToApp(HWND hwnd, const std::wstring& app) {
  ComPtr<IPropertyStore> store;
  if (FAILED(SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(store.GetAddressOf())))) return;
  auto set = [&](REFPROPERTYKEY key, const std::wstring& v) {
    PROPVARIANT pv;
    PropVariantInit(&pv);
    if (SUCCEEDED(SHStrDupW(v.c_str(), &pv.pwszVal))) { pv.vt = VT_LPWSTR; store->SetValue(key, pv); }
    PropVariantClear(&pv);
  };
  set(PKEY_AppUserModel_ID, L"CradsAI.Desktop");
  set(PKEY_AppUserModel_RelaunchCommand, L"\"" + app + L"\"");
  set(PKEY_AppUserModel_RelaunchDisplayNameResource, L"Crads-AI");
  // the same .ico the shortcuts use; the exe's own icon goes stale in the cache
  std::wstring ico = ExeDir() + L"crads-ai.ico";
  if (GetFileAttributesW(ico.c_str()) != INVALID_FILE_ATTRIBUTES) set(PKEY_AppUserModel_RelaunchIconResource, ico + L",0");
  store->Commit();
}

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_SIZE:
      if (g_controller) { RECT r; GetClientRect(h, &r); g_controller->put_Bounds(r); }
      return 0;
    case WM_TIMER:
      if (g_smoke) PostQuitMessage(3);      // smoke watchdog: navigation never completed
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int show) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring url = L"about:blank";
  bool probe = false, haveUrl = false;
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    if (a == L"--smoke") g_smoke = true;
    else if (a == L"--probe") probe = true;
    else { url = a; haveUrl = true; }
  }
  if (probe) {
    LPWSTR ver = nullptr;
    HRESULT hr = GetAvailableCoreWebView2BrowserVersionString(nullptr, &ver);
    if (SUCCEEDED(hr) && ver) { CoTaskMemFree(ver); return 0; }
    return 1;
  }
  // No url: an old pin or a double-click on this exe. Hand over to the app. With
  // no app beside us (a dev build, CI) keep the old about:blank window.
  const std::wstring app = AppExe();
  if (!haveUrl && !app.empty()) return LaunchApp(app) ? 0 : 4;

  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  WNDCLASSW wc = {};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.lpszClassName = L"CradsAIWindow";
  wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));      // resource 1 = the mark (host.rc)
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(13, 17, 23)); // #0D1117: no white flash before paint
  RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"Crads-AI", WS_OVERLAPPEDWINDOW,
    CW_USEDEFAULT, CW_USEDEFAULT, 1200, 840, nullptr, nullptr, inst, nullptr);
  if (!hwnd) return 2;
  // before ShowWindow, so the taskbar button carries them from the start
  if (!app.empty()) PinToApp(hwnd, app);
  // Never start hidden or background-minimised: a window host has no headless
  // mode, and inheriting SW_HIDE from a spawner (node's windowsHide, a stray
  // shortcut) yields a live-but-invisible app, which reads as "won't open".
  if (show == SW_HIDE || show == SW_SHOWMINNOACTIVE || show == SW_SHOWNOACTIVATE) show = SW_SHOWNORMAL;
  ShowWindow(hwnd, show);
  SetForegroundWindow(hwnd);
  if (g_smoke) SetTimer(hwnd, 1, 30000, nullptr);

  // Profile lives under %LOCALAPPDATA%\Crads-AI (the exe dir is not writable-safe).
  // Deliberately NOT the old Edge --app profile dir: WebView2 profiles are not
  // interchangeable with browser profiles, and the app carries no window state worth
  // migrating (identity lives in ~/.ssh + the servers).
  wchar_t local[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
  std::wstring udf = (n && n < MAX_PATH) ? std::wstring(local) + L"\\Crads-AI\\webview2-profile" : L"";

  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, udf.empty() ? nullptr : udf.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
      [hwnd, url](HRESULT res, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(res) || !env) { PostQuitMessage(2); return res; }
        env->CreateCoreWebView2Controller(hwnd,
          Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [hwnd, url](HRESULT res2, ICoreWebView2Controller* ctl) -> HRESULT {
              if (FAILED(res2) || !ctl) { PostQuitMessage(2); return res2; }
              g_controller = ctl;
              g_controller->get_CoreWebView2(&g_webview);
              if (!g_webview) { PostQuitMessage(2); return E_FAIL; }
              RECT r; GetClientRect(hwnd, &r); g_controller->put_Bounds(r);
              // target=_blank and window.open go to the system browser, never a
              // second chromeless webview (sign-in flows, GitHub links, billing)
              EventRegistrationToken tok;
              g_webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT {
                  LPWSTR uri = nullptr;
                  if (SUCCEEDED(a->get_Uri(&uri)) && uri) {
                    ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
                    CoTaskMemFree(uri);
                  }
                  a->put_Handled(TRUE);
                  return S_OK;
                }).Get(), &tok);
              if (g_smoke) {
                EventRegistrationToken t2;
                g_webview->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                  [hwnd](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return S_OK;
                  }).Get(), &t2);
              }
              g_webview->Navigate(url.c_str());
              return S_OK;
            }).Get());
        return S_OK;
      }).Get());
  if (FAILED(hr)) return 2;

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  return (int)msg.wParam;
}
