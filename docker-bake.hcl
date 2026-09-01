# docker-bake.hcl — build the shared base once, then the member + rock variants FROM it.
# `docker buildx bake` (or the CI bake-action) resolves `contexts = { base = "target:base" }`
# so each variant's `FROM base` reuses the base target's cache in one invocation.
# Added 2026-07-16 for the two-image split (see client-deliverables .../TWO-IMAGE-ARCHITECTURE.md).
#
# PINNED TAGS (D30, 2026-07-17): every bake publishes ONE immutable version tag (TAG below).
# Nothing here writes :latest, :v1, or the legacy ai-os:latest alias — those are what the LIVE
# client boxes pull on restart, and they move only by an explicit, human promotion after the
# canary proves the new version:
#   docker buildx imagetools create -t $REG/ai-os-member:latest -t $REG/ai-os:latest $REG/ai-os-member:$TAG
# Rollback = repoint the same way at the previous TAG.
#
# CI (docker-publish.yml) overrides TAG to sha-<commit> since 2026-07-23; :v2 is repointed
# only by .github/workflows/promote.yml (explicit, human- or factory-triggered after approval).

variable "PLATFORMS" { default = ["linux/amd64", "linux/arm64"] }
variable "REG"       { default = "ghcr.io/cradsdavis-cell" }
variable "TAG"       { default = "v2" }
# The commit these images were built from, baked to /etc/aios-build so a box can
# report which engine it is actually running (D55 fleet-version visibility,
# 2026-08-23). Defaults to "unknown" for a local bake with no CI context.
variable "BUILD_SHA" { default = "unknown" }

# PRODUCT VOCABULARY (Sam's 2026-08-05 ruling "a rock is called a rock,
# everywhere", reaching the registry 2026-08-09): the canonical image names are
# crads-base / crads-pebble / crads-rock. The ai-os-* names stay published as
# ALIASES because every live box pulls them by name; they retire only when the
# fleet has restamped onto the new names. Same bytes, both names, every bake.
target "base" {
  dockerfile = "Dockerfile.base"
  platforms  = PLATFORMS
  provenance = false
  tags = ["${REG}/crads-base:${TAG}", "${REG}/ai-os-base:${TAG}"]
}

target "member" {
  dockerfile = "Dockerfile.member"
  contexts   = { base = "target:base" }
  args       = { BUILD_SHA = BUILD_SHA, BUILD_TAG = TAG }
  platforms  = PLATFORMS
  provenance = false
  tags = ["${REG}/crads-pebble:${TAG}", "${REG}/ai-os-member:${TAG}"]
}

target "rock" {
  dockerfile = "Dockerfile.rock"
  contexts   = { base = "target:base" }
  args       = { BUILD_SHA = BUILD_SHA, BUILD_TAG = TAG }
  platforms  = PLATFORMS
  provenance = false
  tags = ["${REG}/crads-rock:${TAG}", "${REG}/ai-os-parent:${TAG}"]
}

group "default" { targets = ["base", "member", "rock"] }
