# Shipping a VM with our own virtio-fs device (track T7)

Marks: [V] verified at the source, [I] inferred, [U] unverified.
Sources: lima v2.3.0 and colima v0.10.3 cloned to the scratchpad; Code-Hex/vz main (HEAD 0ec4d9e, 2026-11-23) and its tags through `gh`; pinata at this worktree.

## Recommendation

Path A plus B: a lima external driver of our own (`lima-driver-<name>`, a patched copy of lima's vz driver that attaches our custom device instead of Apple's virtio-fs), started by pinata through `limactl` with a lima template of pinata's own instead of colima.

- [V] lima loads external drivers by name, and the guest mounts shares only by tag, so neither lima nor the guest needs a change (details under A).
- [V] colima accepts only `qemu`, `vz` and `krunkit` as the VM type (`config/configmanager/configmanager.go` l.61-72; `environment/vm/lima/yaml.go` maps only those three), so colima cannot select our driver without a hack.
- [I] A fallback that keeps colima: lima's `$LIMA_HOME/_config/override.yaml` with `vmType: <ours>` (`pkg/limayaml/load.go` l.34-75, `defaults.go` l.258-263, an override vmType wins). colima passes its environment to `limactl` (`environment/host/host.go` l.56, 82, 105: `append(os.Environ(), ...)`), so `LIMA_DRIVERS_PATH` would reach lima. It is a hack: the file applies to every instance under that `LIMA_HOME`, so pinata would need its own `COLIMA_HOME`, and colima would not know its VM runs another driver. Not tried.

## Path A: our own lima driver

- [V] Interface: `pkg/driver/driver.go`. Lifecycle (Validate, Create, CreateDisk, Start, Stop, Delete, InspectStatus, BootScripts), GUI, snapshots, guest agent forwarding, Info, Configure, SSHAddress, AdditionalSetupForSSH.
- [V] lima itself builds vz as an external driver in 3 lines: `cmd/lima-driver-vz/main_darwin.go`, `server.Serve(context.Background(), vz.New())`. Makefile `ADDITIONAL_DRIVERS=external_vz`, then `codesign -f -v --entitlements vz.entitlements -s -`. `vz.entitlements` holds virtualization, network.server and network.client.
- [V] Discovery: `pkg/registry/registry.go` l.81-137, through `LIMA_DRIVERS_PATH`, then `<prefix>/libexec/lima`. A name equal to a built-in driver is skipped, so we cannot shadow `vz` on Homebrew lima: vz is built in there, and `$(brew --prefix lima)/libexec/lima` has no `lima-driver-vz` (local listing).
- [V] The host agent spawns the driver (`pkg/driver/external/server/server.go` l.216, `exec.CommandContext(path, "--inst-dir", dir)`). The driver process owns the `VZVirtualMachine`, so our device server runs in it, as the API requires.
- [V] vmType selection: `pkg/driverutil/vm.go` l.24-43 accepts any driver in the registry. mountType validation (`pkg/limayaml/validate.go` l.208-216) has no link to vmType, so `mountType: virtiofs` passes with a new driver.
- [V] Reuse: `pkg/driver/vz` exports only `New()`, `LimaVzDriver` and `Enabled`. `createVM` (`vm_darwin.go` l.287-334) and `attachFolderMounts` (l.818-853) are unexported, and there is no hook for extra devices. We must copy and patch about 2,000 lines of non-test Go. Licence Apache-2.0 (`LICENSE`, `NOTICE`), so copying with notice is allowed.
- [V] Mount tags: `directorySharingDevicesGeneric` (l.752-780) uses `limayaml.MountTag(location, mountPoint)` = `lima-%x` of the first 8 bytes of sha256 (`pkg/limayaml/defaults.go` l.110). cloud-init writes the mounts with fstype virtiofs (`pkg/cidata/cidata.go` l.225-290). Our device carries the same tags, and the guest mounts it unchanged. The prototype showed stock Ubuntu 24.04 binds virtiofs to our device (notes-custom-device.md).
- [V] What lima special-cases by the name `vz`, lost under a new name:
  - `cidata.go` l.201 and l.337: DNS when there is no user-mode network. Does not matter with `user-v2` [I].
  - `cidata.TEMPLATE.d/boot.Linux/05-lima-mounts.sh`: runs only when `LIMA_CIDATA_VMTYPE` is `vz` and mount type is virtiofs. It escapes spaces in fstab paths and relabels for SELinux. A share path with a space would break [I]. Fix: a boot script of our own through `BootScripts`, or a provision step.
  - Rosetta is read from `VMOpts["vz"]`, the key and not the driver name, so it still works [V `vm_darwin.go`].
  - Tab completion and list help in `cmd/limactl`. Cosmetic.
- [V] Code-Hex/vz: lima v2.3.0 uses `github.com/Code-Hex/vz/v3 v3.8.0` (`go.mod`). PR #271 (custom virtio devices) merged 2026-10-26 as 8701fbe, after v3.8.0 (2026-09-28). At that commit the module is already `github.com/Code-Hex/vz/v4` (go.mod read through `gh api`). No release contains it, and no issue states a v4 release plan (search "v4 release" found only #239). Bridge code gates on `__MAC_OS_X_VERSION_MAX_ALLOWED >= 270000` (`internal/vzbridge/custom_virtio.m`), so the build needs the macOS 27 SDK. API: `NewCustomVirtioDeviceConfiguration`, `WithCustomVirtioDevices`, `NewCustomVirtioDeviceDelegateProvider`.
  - [I] Options: port the copied driver to v4 at a pinned commit, or keep v3.8.0 and add the custom device with our own Objective-C (as the prototype's `vz27.h` does). v3.8.0 exposes no raw Objective-C pointer, so the second option needs a fork of v3 or a private shim. The v4 port is cleaner.
- [V] External drivers are "experimental and the API may change" (`website/content/en/docs/dev/drivers.md` l.23).
- [I] Build: Go 1.26 with cgo, Xcode or the Command Line Tools with the macOS 27 SDK (local CLT has SDK 26.1, so this Mac cannot build v4's 27 bridge yet [V `xcrun --show-sdk-version`]), C server linked through cgo, ad-hoc codesign with the entitlements.
- [I] Effort: 2-4 weeks for driver copy, device wiring, tests against one lima version.

## Path B: pinata drives lima directly

What pinata runs today [V]:
- `colima version`; `brew install colima` in `pinata install` (`cli/pinata/host.ts` l.33-53, minimum 0.9.0).
- `colima status --profile pinata`, `status --json`, `start --profile pinata --activate=false --mount ... --vm-type vz --mount-type virtiofs --cpu --memory --disk`, `stop`, `ssh --profile pinata -- <cmd>`, `delete --profile pinata --force --data` (`launcher/backend/colima/profile.ts`, `vm.ts`, `size.ts`, `cli/pinata/uninstall.ts` l.56-58). All with `COLIMA_HOME=~/.colima`.
- Reads `~/.colima/pinata/colima.yaml` (size) and `~/.colima/_lima/colima-pinata/lima.yaml` (mounts) (`colima-yaml.ts`, `shares.ts`).
- Socket `~/.colima/pinata/docker.sock`, docker context `colima-pinata`, host alias `host.lima.internal`.
- In the guest over ssh with sudo: CA files under `/usr/local/share/ca-certificates/pinata/`, `update-ca-certificates --fresh`, `/etc/pinata/extra.sha256`, `systemctl restart containerd.service docker.service` (`vm-trust.ts`); `sysctl -w vm.drop_caches=2` (`file-cache.ts`). Needs Docker Engine 28.0 or later (`networks.ts`).
- Host: `lsof` on `_lima/colima-pinata/{disk,diffdisk}` and `_lima/_disks/colima-pinata/datadisk`, `sysctl kern.maxfilesperproc kern.maxfiles`.

What a pinata lima template must redo from colima [V `environment/vm/lima/yaml.go`, `environment/container/docker/docker.go`, `embedded/images/images.txt`]:
- Image: colima-core `ubuntu-24.04-minimal-cloudimg-arm64-docker.raw.gz` (docker preinstalled, sha512 pinned), or a stock Ubuntu cloud image plus docker install in provisioning.
- Network `user-v2`; host resolver with `host.docker.internal` pointing to `host.lima.internal`.
- Port forward of `/var/run/docker.sock` to a host socket; lima's containerd off; no `~/.ssh` keys loaded.
- Provision: inotify sysctls, docker group, hostname, `mount -a`, fstrim, resize2fs of the data disk, `/var/lib/docker` on a data disk, `daemon.json`, host gateway, docker restart.
- The docker context (colima `context.go`).
- Docker updates (colima runs apt for docker-ce).
- [I] Effort: 2-3 weeks to replace `launcher/backend/colima/` with a lima backend, plus docs and threat model.

## Path C: pinata's own VM program

[I] Pinata would own image download and updates, the cloud-init seed, disks and resizing, networking (gvisor-tap-vsock or NAT, port and socket forwarding), ssh, time sync, docker install and updates, status and lifecycle, crash recovery. Months of work and lasting upkeep. Only advantage: no dependency on lima's experimental driver API.

## Path D: something smaller

- [V] No lima or colima issue asks for custom virtio devices, pluggable file sharing, or open-file exhaustion in virtio-fs (searches of both repositories). Related: lima #5651, #5784, #5864; colima #1000, #1607 (closed, mountType validation for krunkit).
- [I] Possible upstream changes: lima's vz driver accepts extra devices (needs vz v4 in lima first), or colima accepts any vmType that lima's registry knows. Either would shrink our work, but timing is outside our control. Worth proposing in parallel, not as the plan.

## Distribution

- [V] Today: one npm package, no `os`/`cpu` fields (`package.json`); release-please, then `npm publish` with trusted publishing and provenance on ubuntu-latest (`.github/workflows/release.yml`).
- [I] Ship the driver prebuilt for darwin-arm64, in an optional dependency with `os: darwin`, `cpu: arm64`, or inside the main package. Building at install would need Go and the macOS 27 SDK on every user's Mac. Pinata sets `LIMA_DRIVERS_PATH` to the package folder when it runs `limactl`.
- [V] Signing: ad hoc with the virtualization entitlement is enough to run a VM (prototype `build.sh`, lima's Makefile).
- [V] Gatekeeper: files written by npm carry no quarantine attribute. Local check: `node_modules/@biomejs/cli-darwin-arm64/biome` has no extended attributes, is ad-hoc signed, `spctl` says rejected, yet it runs. [I] So Developer ID and notarisation are not needed for npm delivery. They would be if the binary is ever downloaded through a browser.
- [V] Release pipeline: needs a macOS job with the 27 SDK. actions/runner-images offers an `xcode-27` arm64 label (public preview, macOS 27.0.1); `macos-latest` is macOS 26. [I] The job builds and signs, then hands the binary to the publish job; provenance is unaffected.
- [I] lima itself: `brew install lima` replaces `brew install colima` in `pinata install`. Keep a supported lima version range and refuse others, because the driver's gRPC API is experimental.

## Minimum system

- [V] The custom device API exists only on macOS 27 (notes-vz-custom-api.md).
- [I] On older macOS, pinata refuses to start with a clear message naming macOS 27 (no backwards compatibility needed). Apple silicon only for the prebuilt binary; Intel not checked [U].

## What stays and what changes for the user

- [I] Same: commands (`pinata install`, launch, `doctor`, `init`, `update`, `uninstall`), config keys `vm.cpus`, `vm.memoryGiB`, `vm.diskGiB`, `workspaceRoot`, mounts.
- [I] Changes: lima instead of colima (install, uninstall text); VM moves from colima profile `pinata` (`~/.colima`) to a lima instance; the old VM and its docker data are deleted once; the docker context name changes; `vm.releaseFileCache` and the `lsof` probe may become unneeded if the device keeps a fixed number of descriptors (prototype keeps 5) [U, depends on T-track results]; docs that name Colima (`launcher/THREAT-MODEL.md` l.20, 89, 90, 160) change.

## Risks

1. lima changes its experimental driver API or vz internals, and a Homebrew lima update breaks our driver. Likely over a year; bad (VM does not start). Mitigation: pin a lima version range, test on each lima release.
2. Code-Hex/vz v4 stays unreleased or changes; we pin a commit. Likely; medium (upkeep, no security fixes by tag).
3. Our C file server has a bug: data loss or a guest-triggered crash or escape into the driver process on the host. Possible; very bad (it now sits on the trust boundary in place of Apple's server). Needs fuzzing and review.
4. Dropping colima's provisioning loses fixes colima would bring (image updates, docker updates). Likely; medium.
5. Lost `vz` special cases (fstab escaping of spaces). Certain if not redone; low.
6. GitHub's `xcode-27` runner is in preview. Possible; low (self-hosted or wait).

## Not verified

- No VM started: neither the override.yaml route nor a renamed driver was tried.
- Building Code-Hex/vz v4's macOS 27 bridge (no 27 SDK here).
- That trusted publishing with provenance works when the binary comes from a macOS job.
- Intel Macs; behaviour if a user's lima comes from a source other than Homebrew.
