# Changelog

## [1.0.0](https://github.com/zharskiy/pinata/compare/v0.4.0...v1.0.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **launcher:** the package is `@zharskiy/pinata` (was `pi-extensions-mz`), and `launcher/install.sh` and `launcher/uninstall.sh` are gone. Install with `npm install -g --legacy-peer-deps @zharskiy/pinata@<version>` and `pinata install`, remove with `pinata uninstall`. Colima 0.9.0 or newer is required, and the fish shell gets no PATH block any more.

### Features

* **launcher:** install, update and uninstall with one pinata command ([920ce1f](https://github.com/zharskiy/pinata/commit/920ce1ffd619315fd496ba74981d2dfa5aeb6090))
* **launcher:** list the sandbox VM and its sessions ([86bfce3](https://github.com/zharskiy/pinata/commit/86bfce384623e18b50e9ec0e5b3050f7c8f28846))
