# Changelog

## [1.3.0](https://github.com/zharskiy/pinata/compare/v1.2.1...v1.3.0) (2026-11-28)


### Features

* **launcher:** apply git settings that keep a status from rewriting the index ([eff0d29](https://github.com/zharskiy/pinata/commit/eff0d294595d7922ecd2c02ea69fbbbc01a72c60))
* **launcher:** pin a prebuilt image with one reference that carries its digest ([579f4d3](https://github.com/zharskiy/pinata/commit/579f4d314aa550931ec19112a25c61005ac6539c))
* **launcher:** raise the Mac's open-file limit at install ([077fcc7](https://github.com/zharskiy/pinata/commit/077fcc77ea5ebab6c6a4cc1878a84553c59c41c7))
* **launcher:** remove the build output overlays ([451a084](https://github.com/zharskiy/pinata/commit/451a084c97dd25f119237cc36c10afbf7488be3a))
* **launcher:** remove the overlays, apply git settings, raise the open-file limit, seed volumes ([5358e7f](https://github.com/zharskiy/pinata/commit/5358e7fce0d11ce85e8ca957748f72fea9105235))
* **launcher:** seed a volume from a folder on the Mac ([72bde3a](https://github.com/zharskiy/pinata/commit/72bde3a514f8399abebebe9df0ca29eb4747adf5))


### Bug Fixes

* **launcher:** finish the install without sudo and say a low open-file limit once ([36b077c](https://github.com/zharskiy/pinata/commit/36b077c0a08dc5d76add079a90c59026d7447063))
* **launcher:** keep the user's own git and shell settings intact around pinata's block ([7684530](https://github.com/zharskiy/pinata/commit/7684530f0c047996ae551f42e17b70db273daad3))
* **launcher:** skip the volume copy off macOS ([5a23011](https://github.com/zharskiy/pinata/commit/5a230116edadfb2da4251714867af6ad7123b84e))
* **launcher:** write a non-ASCII home path into the PATH block as UTF-8 ([cfa159e](https://github.com/zharskiy/pinata/commit/cfa159ee1d222bc4c394fa535570d1510ae9a851))

## [1.2.1](https://github.com/zharskiy/pinata/compare/v1.2.0...v1.2.1) (2026-11-26)


### Bug Fixes

* **subagents:** end an agent's turn once it starts a batch ([a75e727](https://github.com/zharskiy/pinata/commit/a75e727a6a6f3ee40d159080cbee9c00f2a400a2))
* **subagents:** end an agent's turn once it starts a batch ([e309cd9](https://github.com/zharskiy/pinata/commit/e309cd9e28b97727ff752e7ca04b53199a705ab0))
* **subagents:** review a change only once ([9c8ea0d](https://github.com/zharskiy/pinata/commit/9c8ea0d7e8de9871c3ffbebb75dc9c6d828c1b3c))
* **subagents:** review a change only once ([9de622c](https://github.com/zharskiy/pinata/commit/9de622c9f63fce3fb0c3a5583b4b7b5d1152beb9))

## [1.2.0](https://github.com/zharskiy/pinata/compare/v1.1.0...v1.2.0) (2026-11-25)


### Features

* **subagents:** let the planner write the plan file ([2304a8c](https://github.com/zharskiy/pinata/commit/2304a8c82049572943d3003b7fc7db3f47e97686))
* **subagents:** one delegation guide, verifier once at the end, planner writes the plan, no editor agent ([0b192af](https://github.com/zharskiy/pinata/commit/0b192afbf3ec3f7f8e7c54712f59e1f508c61861))
* **subagents:** raise the shipped agents' context limits ([140fed4](https://github.com/zharskiy/pinata/commit/140fed4f46b4635cdb6f6bbb95c5a887b81cf47c))
* **subagents:** remove the editor agent ([e590881](https://github.com/zharskiy/pinata/commit/e59088172466bf4a8aca4e9a8bee3b66202c5295))
* **subagents:** review every change before the verifier runs ([91027ac](https://github.com/zharskiy/pinata/commit/91027ac7d578487063c756c963fbc63ca991af79))
* **subagents:** run the verifier once, at the end ([fe42896](https://github.com/zharskiy/pinata/commit/fe42896f2fa27ed9abc1cb343972c7363717630c))
* **subagents:** share one delegation guide between the main session and leads ([dc8b5ac](https://github.com/zharskiy/pinata/commit/dc8b5ac2d8f1befb46695d2cea2247c80e64e28a))
* **subagents:** ship the code style skill and make the implementer apply it ([5c4c628](https://github.com/zharskiy/pinata/commit/5c4c628889e54fbbc42985e07906fb5e276467f2))

## [1.1.0](https://github.com/zharskiy/pinata/compare/v1.0.0...v1.1.0) (2026-11-24)


### Features

* **launcher:** add pinata uninstall --sandbox ([286d1cf](https://github.com/zharskiy/pinata/commit/286d1cf7eec81da25d75ce58b677037ae5bc698b))
* **launcher:** drop install --config, config --json and update &lt;version&gt; ([c1cf199](https://github.com/zharskiy/pinata/commit/c1cf1994573e15594b94626e8af43cf634222b1e))
* **launcher:** give the report commands the same look ([8dbec15](https://github.com/zharskiy/pinata/commit/8dbec15c66ce611df02097a5e6186966e29f1ee3))
* **launcher:** let pinata update print its own result ([8a8b3f7](https://github.com/zharskiy/pinata/commit/8a8b3f71d185efc3dacebaf4ea6a9e63c2add360))
* **launcher:** make pinata restart delete the VM and create it again ([4e681cd](https://github.com/zharskiy/pinata/commit/4e681cda13edb5de9d8cbc0cf6165957e116c60e))
* **launcher:** move every command under pinata ([46d53c7](https://github.com/zharskiy/pinata/commit/46d53c73b1d0dbb20e59b384f2d3c142509c9b94))
* **launcher:** one pinata command set with restart, uninstall --sandbox and one output style ([dbd9539](https://github.com/zharskiy/pinata/commit/dbd9539c96be484c832e129257c206c20f79cd65))
* **launcher:** print one help table for every --help ([3fd5a41](https://github.com/zharskiy/pinata/commit/3fd5a4143077730b8ebb61ccad881984d704bd35))
* **launcher:** print one line per step in install, update, uninstall and stop ([7a6f731](https://github.com/zharskiy/pinata/commit/7a6f7317c78f6c3f096300d1ced721ad56c3a703))
* **launcher:** refuse to launch without a host pi ([4f8d972](https://github.com/zharskiy/pinata/commit/4f8d97295a68af929e8b381d78f875a59f8d3a10))
* **launcher:** rename pi-sandbox paths, variables and objects to pinata ([afbcc06](https://github.com/zharskiy/pinata/commit/afbcc0619aad2953a7d409f3352b58d3461a4cc0))
* **launcher:** replace sandbox reset with a flagless restart ([d6be435](https://github.com/zharskiy/pinata/commit/d6be43596075e9034737981cf954a217c072e130))
* **launcher:** require a host pi instead of installing one ([235e026](https://github.com/zharskiy/pinata/commit/235e0268952498e989423ea1be0661dba10ca8e6))


### Bug Fixes

* **launcher:** check the settings before pinata restart deletes the VM ([d882ff3](https://github.com/zharskiy/pinata/commit/d882ff32e719b459640a4e38da4cfa1b678bb82e))
* **launcher:** give pinata uninstall --sandbox one closing that is always true ([adfe57e](https://github.com/zharskiy/pinata/commit/adfe57ea09c9cb93963b2e1efbd9298357e64376))
* **launcher:** hold the VM lock while the VM is deleted ([000adad](https://github.com/zharskiy/pinata/commit/000adad8d2b22e97fd0924278da03861384a9335))
* **launcher:** leave npm's pinata command alone ([147e3cb](https://github.com/zharskiy/pinata/commit/147e3cb93619aa2e05c8220e80ec32881cea0d63))
* **launcher:** let pinata uninstall finish without a host pi ([582b0fe](https://github.com/zharskiy/pinata/commit/582b0fe7eb9095a029684f2d56364a8ebc2add60))
* **launcher:** make pinata restart report what it did not do ([bd0bde7](https://github.com/zharskiy/pinata/commit/bd0bde77762077f95ea89701e388fa4de7e709e1))
* **launcher:** refuse pi --version without a host pi ([48a5221](https://github.com/zharskiy/pinata/commit/48a52215cefb90e091ef75c641b1edc2cfcf5369))

## [1.0.0](https://github.com/zharskiy/pinata/compare/v0.4.0...v1.0.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **launcher:** the package is `@zharskiy/pinata` (was `pi-extensions-mz`), and `launcher/install.sh` and `launcher/uninstall.sh` are gone. Install with `npm install -g --legacy-peer-deps @zharskiy/pinata@<version>` and `pinata install`, remove with `pinata uninstall`. Colima 0.9.0 or newer is required, and the fish shell gets no PATH block any more.

### Features

* **launcher:** install, update and uninstall with one pinata command ([920ce1f](https://github.com/zharskiy/pinata/commit/920ce1ffd619315fd496ba74981d2dfa5aeb6090))
* **launcher:** list the sandbox VM and its sessions ([86bfce3](https://github.com/zharskiy/pinata/commit/86bfce384623e18b50e9ec0e5b3050f7c8f28846))
