# Virtualization.framework custom virtio devices (macOS 27): published facts

Legend: [V] = read at the URL given; [R] = read from the Objective-C runtime on this Mac (macOS 27.2) via ctypes; [U] = not verified.
Base for Apple JSON: https://developer.apple.com/tutorials/data/documentation/virtualization/<lowercased symbol>.json (HTTP 200 for all below). Human pages: https://developer.apple.com/documentation/virtualization/<symbol>. Collection: https://developer.apple.com/documentation/virtualization/custom-drivers ("Create custom Virtio drivers for Linux virtual machines.") [V]
All symbols: macOS 27.0+ only [V]. The ObjC variant of each Apple page exists (interfaceLanguage occ) but the JSON I fetched exposes only the Swift declaration text; ObjC selectors below come from the runtime [R].

## A. API

### Object model / flow [V]
1. You build `VZCustomVirtioDeviceConfiguration` (deviceID, pciClassID, pciSubclassID, virtioQueueCount are the four REQUIRED for guest discovery; then features, config space, shared memory regions, provider) and add it to the VM configuration (how it is added to VZVirtualMachineConfiguration is NOT on the pages I read; see "open points").
2. The framework creates the `VZCustomVirtioDevice` itself when the `VZVirtualMachine` is created, and hands it to you via `customVirtioConfiguration(_:didCreateDevice:)` on the delegate of the provider. You never instantiate the device. (https://developer.apple.com/tutorials/data/documentation/virtualization/vzcustomvirtiodeviceconfiguration.json)
3. `VZCustomVirtioDeviceDelegateProvider(deviceQueue:delegate:)` is the only provider subclass. "The delegate runs in the same process as the guest's VZVirtualMachine instance." (vzcustomvirtiodevicedelegateprovider.json) The base `VZCustomVirtioDeviceProvider` is abstract ("Don't instantiate directly"); runtime shows a private `_connectionIdentifier` (variant of PluginIdentifier | XPC endpoint) so an out-of-process/plugin provider exists privately [R], not public.
4. Threading: "The Virtualization framework performs all operations on the VZCustomVirtioDevice and VZCustomVirtioDeviceDelegate through a serial queue that you can configure through the deviceQueue property. If the queue isn't set, the framework performs all operations on the queue in the VM's VZVirtualMachine queue property by default." (vzcustomvirtiodevice.json) `deviceQueue` doc: "The framework performs all operations on VZCustomVirtioDevice and VZCustomVirtioDeviceDelegate on this serial queue." (vzcustomvirtiodevice/devicequeue.json). So notification callbacks arrive on the serial deviceQueue you pass to the provider init. Shared-memory map/unmap completion handlers are also invoked on deviceQueue.

### VZCustomVirtioDeviceConfiguration  (macOS 27.0, NSObject, NSCopying) [V]
```
class VZCustomVirtioDeviceConfiguration
  var deviceID: UInt16                      // {get set}  "The Virtio device ID of the device."
  var pciClassID: UInt8                     // {get set}
  var pciSubclassID: UInt8                  // {get set}
  var virtioQueueCount: UInt16              // {get set}  "number of virtqueues"
  var mandatoryFeatures: VZVirtioFeatureSet // {get}  (class is mutable: subset0/subset1 settable [R])
  var optionalFeatures: VZVirtioFeatureSet  // {get}
  var deviceSpecificConfiguration: VZVirtioDeviceSpecificConfiguration? // {get set}
  var sharedMemoryRegions: [VZVirtioSharedMemoryRegionConfiguration]
  var provider: VZCustomVirtioDeviceProvider? // {get set} "This data defines how the virtual device is implemented."
  var supportsSaveRestore: Bool             // {get set} default NO
  class var maximumAllowedSharedMemoryRegionCount: Int  // {get}  value not documented
```
Runtime selectors [R]: `setDeviceID:`(S) `deviceID` `PCIClassID`/`setPCIClassID:`(C) `PCISubclassID`/`setPCISubclassID:`(C) `setVirtioQueueCount:`(S) `mandatoryFeatures` `optionalFeatures` `setMandatoryFeatures:atIndex:`(I,Q) `setOptionalFeatures:atIndex:`(I,Q) `mandatoryFeaturesAtIndex:` `optionalFeaturesAtIndex:` `setSharedMemoryRegions:` `setProvider:` `setDeviceSpecificConfiguration:` `setSupportsSaveRestore:` `+maximumAllowedSharedMemoryRegionCount` (Q). Private ones present: `_PCIVendorID` `_PCIDeviceID` `_PCISubsystemID` `_PCISubsystemVendorID` `_pluginName` `_pluginPersonality` `_supportsSaveRestore` (all with `_set...`). No public queue-size or PCI vendor/device ID property.
Semantics [V]:
- mandatoryFeatures: "features that the device offers and the guest must accept. The framework won't successfully initialize the device if the guest driver fails to accept this set of features. The feature bit VIRTIO_F_VERSION_1 is always set to 1 internally by default."
- optionalFeatures: "features that the guest driver may or may not accept, see negotiatedFeatures ... A few feature bits are always set internally by default for optimal performance." (which ones: not stated)
- supportsSaveRestore: "If supportsSaveRestore is YES but the delegate set on VZCustomVirtioDevice does not actually implement the save/restore methods, an exception will be raised."
  (URLs: .../vzcustomvirtiodeviceconfiguration/mandatoryfeatures.json, /optionalfeatures.json, /supportssaverestore.json)

### VZCustomVirtioDevice (27.0, NSObject, not copyable) [V]
```
class VZCustomVirtioDevice
  var delegate: (any VZCustomVirtioDeviceDelegate)?
  var deviceQueue: dispatch_queue_t { get }
  var negotiatedFeatures: VZNegotiatedVirtioFeatureSet?   // nil if no negotiation yet
  var sharedMemoryRegions: [VZVirtioSharedMemoryRegion] { get }
  func guestMemoryMapping(atPhysicalAddress physicalAddress: UInt64, length: Int) -> VZGuestMemoryMapping?
  func queue(at index: UInt16) -> VZVirtioQueue?
  func requestReset()
  func update(_ newConfiguration: VZVirtioDeviceSpecificConfiguration, completionHandler: @escaping @Sendable ((any Error)?) -> Void)
  func update(_ newConfiguration: VZVirtioDeviceSpecificConfiguration) async throws
```
Runtime [R]: `setDelegate:` `delegate` `deviceQueue` `negotiatedFeatures` `queueAtIndex:`(S) `requestDeviceReset` `guestMemoryMappingAtPhysicalAddress:length:`(Q,Q) `updateDeviceSpecificConfiguration:completionHandler:` `sharedMemoryRegions`; also `driverFeaturesAt:error:` (I, ^@) and `guestMemoryAtPhysicalAddress:length:` (unlisted/private-ish, not on Apple's pages).
- `queue(at:)`: "nil if the index is invalid or the guest driver has disabled the queue. The framework sets up the virtqueues when the guest driver sets DRIVER_OK; this call returns a valid result only after the framework calls customVirtioDeviceDidAcceptDriverOk(_:)." (vzcustomvirtiodevice/queue(at:).json)
- `guestMemoryMapping`: returns nil "if physicalAddress and length do not reference a valid guest RAM region". This is the escape hatch to map guest RAM at an arbitrary guest-physical address (for FUSE_READ/WRITE with addresses you already know, or DAX bookkeeping). (.../guestmemorymapping(atphysicaladdress:length:).json)
- `requestReset()`: sets DEVICE_NEEDS_RESET; "the guest may or may not take action"; framework calls `customVirtioDeviceWillReset(_:)` when reset happens (either side).
- `update(_:)` (config space change): "The size of the underlying data for the new configuration must be the same as the previous configuration. The framework raises an exception if this condition isn't met." So config space length is fixed at creation; content mutable after.

### VZVirtioDeviceSpecificConfiguration (27.0, NSObject, NSCopying) [V]
```
init(configurationData: Data)
var configurationData: Data
```
Prose: "Serialize any device-specific configuration structure into an NSData object ... set this object on the deviceSpecificConfiguration property." Raw bytes as the device config space. (vzvirtiodevicespecificconfiguration.json) ObjC: `initWithConfigurationData:` [R]. (Guest-initiated config-space writes: no callback on the delegate protocol; not documented.)

### VZVirtioFeatureSet / VZNegotiatedVirtioFeatureSet (27.0) [V]
```
class VZVirtioFeatureSet            var subset0: UInt32  // bits 0-31   var subset1: UInt32 // bits 32-63
class VZNegotiatedVirtioFeatureSet  var subset0: UInt32; var subset1: UInt32   // read-only
```
"encapsulates the 64-bit Virtio feature set as two 32-bit subsets." Negotiation happens at guest boot; result in `device.negotiatedFeatures`. (vzvirtiofeatureset.json, vznegotiatedvirtiofeatureset.json). Bits >=64 not representable (irrelevant to virtio-fs). Note virtio-fs has no device-specific feature bit except NOTIFICATION (bit 0) per spec, see Part C.

### VZCustomVirtioDeviceProvider / DelegateProvider (27.0) [V]
```
class VZCustomVirtioDeviceProvider                       // abstract base
class VZCustomVirtioDeviceDelegateProvider : VZCustomVirtioDeviceProvider
  init(deviceQueue: dispatch_queue_t, delegate: any VZCustomVirtioDeviceConfigurationDelegate)
  var delegate: (any VZCustomVirtioDeviceConfigurationDelegate)?
  var deviceQueue: dispatch_queue_t
```
ObjC `initWithDeviceQueue:delegate:` [R]. Note: the provider's delegate is the *Configuration*Delegate (only `didCreateDevice`); the per-device delegate (`VZCustomVirtioDeviceDelegate`) is set by you on the created device in that callback (`setDelegate:`).

### Protocols [V]
```
protocol VZCustomVirtioDeviceConfigurationDelegate : NSObjectProtocol
  func customVirtioConfiguration(_ configuration: VZCustomVirtioDeviceConfiguration, didCreateDevice device: VZCustomVirtioDevice)   // (required? doc shows non-optional; runtime says optional=NO list empty -> declared optional in ObjC protocol [R])

protocol VZCustomVirtioDeviceDelegate : NSObjectProtocol    // all methods `optional`
  optional func customVirtioDevice(_ device: VZCustomVirtioDevice, didReceiveNotificationFor queue: VZVirtioQueue)
  optional func customVirtioDeviceDidAcceptDriverOk(_ device: VZCustomVirtioDevice)
  optional func customVirtioDeviceWillReset(_ device: VZCustomVirtioDevice)
  optional func customVirtioDeviceWillStop(_ device: VZCustomVirtioDevice)
  optional func customVirtioDeviceWillPause(_ device: VZCustomVirtioDevice)
  optional func customVirtioDeviceWillResume(_ device: VZCustomVirtioDevice)
  optional func customVirtioDeviceSaveState(forRestore device: VZCustomVirtioDevice) -> Data?
  optional func customVirtioDeviceShouldRestore(_ device: VZCustomVirtioDevice, saveState: Data) -> Bool
```
ObjC selectors [R]: `customVirtioDevice:didReceiveNotificationForQueue:` `customVirtioDeviceDidAcceptDriverOk:` `customVirtioDeviceWillReset:` `customVirtioDeviceWillStop:` `customVirtioDeviceWillPause:` `customVirtioDeviceWillResume:` `customVirtioDeviceSaveStateForRestore:` `customVirtioDeviceShouldRestore:saveState:` `customVirtioConfiguration:didCreateDevice:`. All were reported as optional in the runtime protocol description (the config delegate too).
Prose [V]: DRIVER_OK == device ready ("the guest driver is set up and ready to drive the device"). Notification: "the framework invokes customVirtioDevice(_:didReceiveNotificationFor:) when the guest driver sends the device a virtqueue notification." (vzcustomvirtiodevicedelegate.json) willReset: called "when the reset completes" for host- or guest-initiated reset.
NO documented per-callback thread beyond "serial deviceQueue".

### VZVirtioQueue (27.0, not instantiable) [V]
```
var queueIndex: UInt16
var queueSize: UInt16          // "maximum number of VZVirtioQueueElement that can be made available in the queue"
func nextElement() -> VZVirtioQueueElement?
```
- Obtain only via `device.queue(at:)` (after DRIVER_OK).
- Queue COUNT is declared by you (`virtioQueueCount`); queue SIZE is NOT a configurable property: it is a read-only value (`queueSize`), presumably chosen by the guest driver per virtio rules [U: not stated who picks it].
- `nextElement()`: "next available element ... or nil if no elements are available or if the device is no longer live." "When using this method, the framework disables virtqueue notifications until you have consumed every available element. When calling this method in response to a virtqueue notification, you need to do so repeatedly until it returns nil ... typically in a loop." (vzvirtioqueue/nextelement().json) => suppression of notifications (EVENT_IDX / NO_NOTIFY) is done by the framework between first nextElement() and the nil return. There is no API to manually enable/disable notifications, no "kick the guest" call (interrupt injection is implicit in returnToQueue).

### VZVirtioQueueElement (27.0, not instantiable) [V]
```
var readBuffersByteCount: Int                  var readBuffersAvailableByteCount: Int
var writeBuffersByteCount: Int                 var writeBuffersAvailableByteCount: Int
var writtenByteCount: Int
func readBuffers() -> [Data]                   // scatter-gather, "directly referencing guest memory without any extra copy"; afterwards readBuffersAvailableByteCount == 0
func readBytes(withExactLength exactLength: Int) throws -> Data            // copies into new NSData
func readBytes(intoBuffer: UnsafeMutableRawPointer, exactLength: Int) throws   // copy into your buffer
func peekIntoReadBuffers(withExactLength exactLength: Int) throws -> Data   // copy, does not consume
func write(_ data: Data) throws                                             // copy into write buffers
func writeBuffer(_ buffer: UnsafeMutableRawPointer, exactLength: Int) throws
func returnToQueue()
```
Runtime extras [R]: `readBytes:error:` `readBytesInto:length:error:` `writeData:error:` `writeData:length:error:` `write:error:` `peekIntoReadBuffers:error:` (older/alternate selector names, probably aliases).
Prose [V] (vzvirtioqueueelement.json): element = a descriptor chain; read buffers = device-readable (guest->host), write buffers = device-writable; "exposes the scatter-gather memory to the guest's DRAM ... read-only and write-only access". "Strongly recommended to access the read buffers and write buffers only once" (TOCTOU) using readBytes/write which "enforce that you only access the memory once". `peek` is the only multi-read path. "When you are done ... call returnToQueue() to return the element back to the guest."
- returnToQueue: "Attempts to call this method more than once with the same element results in the framework raising an exception." (vzvirtioqueueelement/returntoqueue().json)
- Writes: there is NO mapped writable pointer for write buffers in the public API; only `write(Data)`/`writeBuffer` (copy). Reads: `readBuffers()` gives zero-copy `[Data]` views of guest RAM (Data wrapping guest memory); reading is the zero-copy path, writing is copy [V as read; "no mapped writable view" is my inference from absence].
- Sequential writes: `writtenByteCount` advances; there is no random-access write into write buffers (inference).
- Thread / order: pages do not say whether returnToQueue may be called off deviceQueue or out of order. [U]. (Virtio permits out-of-order completion; with an `Element` object per chain it is natural but unconfirmed.)
- Used length reported to guest: there is no explicit "len" parameter in returnToQueue; presumably `writtenByteCount` [U].

### VZGuestMemoryMapping (27.0) [V]
```
var physicalAddress: UInt64    var length: Int    var mutableBytes: UnsafeMutableRawPointer
```
"holds a reference to all of the host memory allocated for the guest's DRAM. When the VM is rebooted or shutdown, the allocated host memory becomes invalidated and remapped. ... can't be used across a reboot or shutdown." (vzguestmemorymapping.json) Read+write host pointer into guest RAM.

### Shared memory regions [V]
```
class VZVirtioSharedMemoryRegionConfiguration : NSObject, NSCopying
  init(regionID: UInt8, size: UInt64)          // ObjC initWithRegionID:size: [R]
  var regionID: UInt8; var size: UInt64
class VZVirtioSharedMemoryRegion (not instantiable)
  var regionID: UInt8; var size: UInt64
  func mapMemory(_ memory: UnsafeMutableRawPointer, atOffset offset: UInt64, size: UInt64, completionHandler: @escaping @Sendable ((any Error)?) -> Void)
  func mapMemory(_ memory: UnsafeMutableRawPointer, atOffset offset: UInt64, size: UInt64) async throws
  func unmapMemory(atOffset offset: UInt64, size: UInt64, completionHandler: ...)
  func unmapMemory(atOffset offset: UInt64, size: UInt64) async throws
```
Prose: "continuously shared between the custom Virtio device implementation and the guest. A shared memory region is identified by an ID, whose meaning is specific to the device." After configuration "the framework advertises the shared memory region to the guest". At runtime "map and unmap host memory into and from the shared memory region." Completion blocks "invoked on deviceQueue". Host memory passed is a raw pointer (mmap-able memory presumably page-aligned; alignment/granularity requirements, whether file-backed mmap of a Mac file works, and the maximum region size/count are NOT stated [U]). This is the virtio-fs DAX window primitive: virtio-fs spec uses shared memory region id 0 for the cache/DAX window. Advertised through virtio-pci SHARED_MEMORY_CFG capability presumably [U].

## Open points the pages do NOT answer (to be closed by session transcript/forums, see below)
- How a VZCustomVirtioDeviceConfiguration is attached to a VZVirtualMachineConfiguration (property name, likely `customVirtioDevices` or in `otherDevices`?) [U, checking].
- Whether device id 26 / Apple-reserved ids are refused [U].
- Entitlements for custom devices [U].

## A2. Additions after reading the WWDC page and third-party bindings

### Attaching to the VM [V]
`VZVirtualMachineConfiguration.customVirtioDevices: [VZCustomVirtioDeviceConfiguration]` (default empty; runtime selectors `customVirtioDevices`/`setCustomVirtioDevices:` [R]) https://developer.apple.com/tutorials/data/documentation/virtualization/vzvirtualmachineconfiguration/customvirtiodevices.json
Runtime also shows private `_customMMIODevices` / `_setCustomMMIODevices:` [R] (so a non-PCI MMIO variant exists privately).

### WWDC26 session 224 (https://developer.apple.com/videos/play/wwdc2026/224/) [V, via a summarising fetch tool; quotes are from its transcript output]
- "In macOS 27, the Virtualization framework allows you to implement your own Virtio devices, allowing custom communication between your host app and your Linux virtual machines."
- Flow: VZCustomVirtioDeviceConfiguration (device id, PCI class/subclass, queue count) -> provider = VZCustomVirtioDeviceDelegateProvider -> `virtualMachineConfiguration.customVirtioDevices = [deviceConfiguration]` -> `VZVirtualMachine(configuration:)` -> "When the virtual machine is started, a VZCustomVirtioDevice object is created, and your configuration delegate's didCreateDevice function is called. In this function, you should set the device's delegate ... hang onto the device itself so that your device can trigger guest interrupts."
  (NOTE: pages say the device is created "upon the creation of the VZVirtualMachine"; the talk says "when the virtual machine is started". Inconsistent; test it.)
- Example in the talk: deviceID = 4 (entropy), pciClassID = 0x10, pciSubclassID = 0x00, virtioQueueCount = 1. Loop shown:
  ```swift
  func customVirtioDevice(_ device: VZCustomVirtioDevice, didReceiveNotificationFor queue: VZVirtioQueue) {
      while let element = queue.nextElement() { /* process */ element.returnToQueue() }
  }
  ```
- "You can also initiate activity in the guest by triggering an interrupt on the device." BUT the runtime list of VZCustomVirtioDevice methods has NO interrupt method [R]; the only host->guest signal is `returnToQueue()` (used-ring update + interrupt) [inference]. An unsolicited host->guest message needs a guest-posted buffer (e.g. FUSE notify/hiprio pattern) to be returned.
- Talk: shared memory discussed only conceptually; entitlements, threading rules, id restrictions, sample code: not mentioned. No sample-code project for this session found [U].
- Talk page lists virtio spec v1.4: https://docs.oasis-open.org/virtio/virtio/v1.4/virtio-v1.4.html

### Linux guests only [V]
Collection page abstract: "Create custom Virtio drivers for Linux virtual machines." (custom-drivers.json) Pages also say a custom device needs a matching guest driver. For virtio-fs the Linux in-tree `virtiofs` driver binds on PCI vendor 0x1AF4 + id 0x1040+26 if device appears as modern virtio-pci [U: vendor/device PCI IDs not exposed publicly; `_PCIVendorID`/`_PCIDeviceID` are private setters, presumably defaulted from deviceID; the config's pciClassID/pciSubclassID are required, Linux virtio-pci does not match on class so any value should do — Code-Hex test uses class 0xff/sub 0 with device id 4 and a real Linux guest reads /dev/hwrng from it (see B)].

### Not found on Apple's pages [U]
- Whether deviceID 26 (or other Apple-implemented ids such as 1 net, 2 blk, 4 rng, 16 gpu, 19 vsock, 26 fs which VZVirtioFileSystemDeviceConfiguration already provides) is refused: no doc statement. Code-Hex/vz test uses id 4 (entropy) after *removing* the framework's entropy device `config.SetEntropyDevicesVirtualMachineConfiguration(nil)`, which hints that duplicates may be fine but is not evidence of refusal. Test id 26 live; also with a stock VZVirtioFileSystemDeviceConfiguration absent.
- Entitlements for custom virtio devices: none mentioned in docs, talk, or Code-Hex/vz PR text (which names an entitlement only for USB AccessoryAccess). Treat com.apple.security.virtualization as the only one [U].
- Which thread may call returnToQueue/nextElement/write: pages say only "serial deviceQueue". Code-Hex/vz wraps every element call in `vzbridge.OnCustomVirtioQueue` (dispatch_sync onto the device queue) and documents "individual device and queue methods dispatch to it as well" and shows doing blocking I/O off-queue then `RunOnDeviceQueue(write + returnToQueue)` (https://github.com/Code-Hex/vz/blob/main/custom_virtio.go). Suggests off-queue calls are either unsafe or must be serialised by the caller [binding author's choice, not an Apple statement]. Out-of-order return from a worker: that Go doc example does exactly this (element retained, returned later) so retaining elements across callbacks and returning later appears to work [V as documented usage; not confirmed by Apple].
- Queue size choice, ring format: private header shows `split` and `packed` ring descriptor layouts in the implementation [V: https://github.com/thatmarcel/macOS-26.4-headers/blob/main/headers/Virtualization/_VZVirtioQueueElement.h], so packed ring may be supported; the public API exposes no feature knobs beyond the 64 bits.

### Facts from Code-Hex/vz bindings (macOS 27, an independent reading of the behaviour) https://github.com/Code-Hex/vz (PR #271 "feat(vz): support macOS 27 Virtualization APIs", merged 2026-10-26)
- `VirtioSharedMemoryRegion.MapMemory`: "memory, offset, and size must be aligned to the host page size. memory must point to non-Go memory that remains allocated until unmapping completes. completion runs on the device queue and must not block it." (custom_virtio_memory.go) The binding enforces 16 KiB page alignment (os.Getpagesize on arm64) and `offset+size <= region size`; this is the binding's check, not an Apple statement.
- `NextElement` doc: break out early => notifications for that queue stay disabled; "explicitly resume consuming the queue later. Waiting for another notification will not resume it." (custom_virtio_queue.go)
- "Each Custom Virtio device instance needs its own delegate provider"; a provider cannot be reused across VMs/devices (binding rule). "Methods must not wait for virtual machine operations, which may themselves wait for the delegate".
- Setting `supportsSaveRestore` requires the delegate to implement both save/restore methods.
- Private SPI predecessor in macOS 26.4 (`_VZCustomVirtioDevice`, `_VZVirtioQueue...`, XPC plugin based with `_pluginName`/`_pluginPersonality`): https://github.com/thatmarcel/macOS-26.4-headers/tree/main/headers/Virtualization. apple/security-pcc uses it (AppleCIOMesh/VirtMesh/Host/AppleVirtMeshPlugin/IOBridge.mm, Plugin.mm): https://github.com/apple/security-pcc

## B. Who already uses it (GitHub, read via `gh api`, 2026-11-25)

No virtio-fs / 9p / vsock / FUSE server on VZCustomVirtioDevice found in any project (code searches for "VZCustomVirtioDevice", "customVirtioDevices", "VZVirtioSharedMemoryRegion", "VZCustomVirtioDeviceDelegateProvider" return only the items below). lima, colima, vfkit, Tart, apple/containerization, apple/container, libkrun: no issue or code hit for "custom virtio" (gh issue search per repo returned nothing; tart and libkrun searches errored, not retried) [U for those two]. UTM only has a wish issue.

### Working device implementations (all GPU, not fs)
1. Quiet-Wolfe/vzgpu https://github.com/Quiet-Wolfe/vzgpu (Objective-C, last push 2026-10-15). virtio-gpu (device id 16) Venus on VZCustomVirtioDevice, "verified on macOS 27.2 / M5, Fedora 45 guest, kernel 7.2.0-61.fc45". Most useful reference for the plumbing: https://github.com/Quiet-Wolfe/vzgpu/blob/main/vzgpu.m (lines ~208-250, 625-700, 912-935) and README. Facts [V, from README/source]:
   - Config used: `deviceID=16; PCIClassID=0x03; PCISubclassID=0x80; virtioQueueCount=2; optionalFeatures.subset0 = bit mask; deviceSpecificConfiguration = initWithConfigurationData:(20-byte struct); sharedMemoryRegions=@[initWithRegionID:1 size:8 GiB]; provider = initWithDeviceQueue:(serial queue) delegate:`; `cfg.customVirtioDevices=@[g]`; `[cfg validateWithError:]` passes. => ids that Apple itself implements (16 = GPU) ARE accepted (with no Apple graphics device configured). 26 untested by them.
   - Entitlements: the only entitlement in their plist is `com.apple.security.virtualization`; signed with `codesign -s - -f --entitlements vzgpu.entitlements`. => no extra entitlement for custom devices [V: https://github.com/Quiet-Wolfe/vzgpu/blob/main/vzgpu.entitlements and README "Running"].
   - Shared memory: 8 GiB region (id 1) accepted. "VZ maps host memory at 16 KiB granularity" (host page size; device sets blob_alignment=16384). `mapMemory`/`unmapMemory` complete asynchronously: "The guest sends UNREF without waiting for UNMAP", so the host must defer freeing until the unmap completion ran.
   - "VZ negotiates packed virtqueues (subset1 bit 34) by default" (VIRTIO_F_RING_PACKED = 34 [spec]; this is their observation).
   - Deferred completion: elements taken from `nextElement` are kept in a `_pending` list and `[element returnToQueue]` is called later from a block dispatched with `dispatch_async(deviceQueue, ...)` when fences complete, i.e. out-of-order, in a later callback, but always on the device queue. Backend threads never touch the element directly.
   - Host memory for mapMemory in their case was a pointer from virglrenderer (`virgl_renderer_resource_get_map_ptr`) or a POSIX shm mapping (cross-domain); alignment 16 KiB required for pointer, offset and size (also asserted by Code-Hex binding).
   - Open defects there: serial console hvc0 stops draining after a while (cause unknown); no performance figures for notifications.
2. everettjf/ezvm (a.k.a. riftvm) https://github.com/everettjf/ezvm : docs/CUSTOM_VIRGL_ARCHITECTURE.md, Experiments/VZVirtioGPUPrototype/README.md, docs/VIRGL_PERFORMANCE.md (VirGL -> ANGLE -> Metal on macOS 27; reported ~60 FPS, 0.4-0.8 ms presentation time, idle Hyprland). Frame/present numbers only; no per-notification latency [V].
3. rderaison/bromure GPU_FEASIBILITY_STUDY.md, tools/gpu/validate-custom-virtio.swift https://github.com/rderaison/bromure : probe that binds Linux virtio_gpu via custom device (feasibility study). Study text: "Public mapMemory documentation is too sparse to promise that integration" and "Confirm SDK validation permits the intended device configuration" (i.e. they too had not proven id validation by then). Their probe reads guest RAM via guestMemoryMapping(atPhysicalAddress:length:) and copies once.
4. Code-Hex/vz (Go bindings used by lima's `vz` vmType) https://github.com/Code-Hex/vz : PR #271 "feat(vz): support macOS 27 Virtualization APIs" merged 2026-10-26 (commit `feat(vz): support macOS 27 Virtualization APIs (#271)`); files custom_virtio.go, custom_virtio_queue.go, custom_virtio_memory.go, custom_virtio_configuration.go, internal/vzbridge/custom_virtio.m, tests custom_virtio_guest_test.go (device id 4 entropy, class 0xff, real Linux guest `dd if=/dev/hwrng` returns the bytes the Go delegate wrote). Requires lima to adopt a Code-Hex/vz release with this; whether lima exposes custom devices: not found [U].
5. apple/security-pcc (private _VZ SPI predecessor, macOS 26.x, XPC plugin style) https://github.com/apple/security-pcc/tree/main/AppleCIOMesh/VirtMesh/Host/AppleVirtMeshPlugin
6. Others referencing it (wish/prototypes, no data): utmapp/UTM#7921 (osy: "something I've been looking into but it'll have to be after Neptune stabilizes"); vale21/mac-mulator#121 (plan: virtio-gpu id 16, shared memory region 1, "VZVirtualMachineView does not display custom devices"); Fandhe-AI/fandhe-container (issues #1052, #1057, #1521-1523: virtio-gpu registration on macOS 27); drawmeanelephant/VirelaiOS (host/vm-runner VMGPU3D); Ark0N/Codeman docs/vm-subsystem-apple-stack.md; pdparchitect/noodle; ronaldoussoren/pyobjc (metadata only).
7. Offline-only findings from the above: VZVirtualMachineView does not display custom devices (a custom GPU must present itself); a hosting `VZVirtualMachine` hosts the delegate in-process.

### Performance figures / complaints for per-notification latency or threading
None published that I could find [U]. Threading: everything on one serial deviceQueue per provider; a different provider (own queue) per device. Code-Hex/vz documents: "Methods must not wait for virtual machine operations, which may themselves wait for the delegate, or workers that need the device queue" (deadlock risk). Bugs in 27.0-27.2: none documented against VZ itself; defects found in vzgpu were in virglrenderer, not VZ.

## C. How a driver of our own would plug in

### C1. lima 2.x external drivers [V unless noted]
Doc: https://github.com/lima-vm/lima/blob/master/website/content/en/docs/dev/drivers.md ("Lima >= 2.0"; "External drivers are experimental and the API may change"). Latest release seen: v2.3.0 (2026-11-06).
- Discovery: executables named `lima-driver-<name>` (no `.exe` on unix) in (1) each path of env `LIMA_DRIVERS_PATH` (a dir or a single executable file; path-list separated like PATH) and (2) the standard `<lima prefix>/libexec/lima/` dirs; a name already registered as an internal driver (qemu, vz) is skipped. Code: https://github.com/lima-vm/lima/blob/master/pkg/registry/registry.go (functions discoverDrivers, registerDriverFile).
- Can a third-party binary be installed without rebuilding lima: YES. Documented step: "Build your driver ... Place the binary in a directory accessible via LIMA_DRIVERS_PATH" and use `limactl create myinstance --vm-type=mydriver template:default`. The shipped `lima-driver-krunkit` is just such a binary in `<prefix>/libexec/lima/` (Homebrew: `.../Cellar/lima/<ver>/libexec/lima/lima-driver-krunkit`) per https://github.com/lima-vm/lima/blob/master/website/content/en/docs/config/vmtype/krunkit.md . The driver must be written against lima's Go `driver.Driver` interface using `github.com/lima-vm/lima/v2/pkg/driver/external/server.Serve()` (so a Go program importing lima v2 packages; or any language that speaks the gRPC contract).
- Protocol: gRPC over a unix socket in the instance directory `~/.lima/<instance>/lima-driver-<name>.sock` (moved from /tmp in 2.1; breaking notes https://github.com/lima-vm/lima/blob/master/website/content/en/docs/releases/breaking.md). Contract: https://github.com/lima-vm/lima/blob/master/pkg/driver/external/driver.proto . RPCs: Validate, Create, CreateDisk, Start (server-streaming), Stop, Delete, BootScripts, RunGUI, ChangeDisplayPassword, GetDisplayConnection, Create/Apply/Delete/ListSnapshots, ForwardGuestAgent, GuestAgentConn, Configure (JSON payload), Info (JSON: name, vsockPort, virtioPort, instanceDir, features{canRunGui, dynamicSSHAddress, staticSSHPort, skipSocketForwarding, noCloudInit, rosettaEnabled, rosettaBinFmt, supportedImageFormats}), SSHAddress, AdditionalSetupForSSH. Struct: https://github.com/lima-vm/lima/blob/master/pkg/driver/driver.go . Call order: Configure, Validate, Create, CreateDisk, Start, AdditionalSetupForSSH, SSHAddress. API is unstable (breaking changes in 2.1: snapshot IDs, Configure signature).
- Own mount type: NO. `limatype.MountTypes = {reverse-sshfs, 9p, virtiofs, wsl2}` and validate.go rejects any other `mountType` ("field `mountType` must be ... got"), https://github.com/lima-vm/lima/blob/master/pkg/limayaml/validate.go (l.208-216) and pkg/limatype/lima_yaml.go l.96-110. `Info` has no mount-type field. A driver can however validate/restrict mount types (krunkit driver accepts only virtiofs and reverse-sshfs: pkg/driver/krunkit/krunkit_driver_darwin_arm64.go l.301) and implement "virtiofs" with its own server: the guest sees an ordinary `mount -t virtiofs <tag>` (cidata boot script pkg/cidata/cidata.TEMPLATE.d/boot.Linux/05-lima-mounts.sh), so the guest side stays stock. The driver's own device must expose tag names the cidata script expects (tag naming scheme: not read, [U]).
- VMType in lima is a free string (`VMType = string`; constants QEMU, VZ, WSL2, HCS in pkg/limatype/lima_yaml.go l.77-111; "krunkit" is a driver name, not in that list) so an unknown vmType resolves through the registry.
- Lima's own `vz` driver uses Code-Hex/vz; it only exposes `VZVirtioFileSystemDeviceConfiguration`/VZSingleDirectoryShare for virtiofs (Apple's own in-framework server, which is the fd-holding one) [U exact lines not read].

### C2. colima 0.10.x [V]
colima latest release seen: v0.10.3 (2026-06-04). `vmType` is NOT free-form: config validation has a fixed map `validVMTypes := {"qemu","vz","krunkit"}` (vz/krunkit conditional on macOS/arch), error "invalid vmType: '%s'": https://github.com/abiosoft/colima/blob/main/config/configmanager/configmanager.go (l.61-72); CLI flag `--vm-type/-t` help lists qemu, vz, krunkit: https://github.com/abiosoft/colima/blob/main/cmd/start.go (l.174-226); mapping function `limaVMType` returns only qemu/vz/krunkit: https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go (l.24-37). Mount types accepted: sshfs, 9p, virtiofs (cmd/start.go l.172). So a colima profile cannot select a third-party lima vmType in 0.10.x; options: replace/shadow the `lima-driver-krunkit` binary [hack], or fork colima [U], or use lima directly (colima writes a lima YAML; overriding via lima `override.yaml` in colima's lima dir was not checked [U]).

### C3. What a command-line program needs to use Virtualization.framework [V]
- Entitlement `com.apple.security.virtualization` = true, ad-hoc signing: `codesign -s - -f --entitlements vzgpu.entitlements <binary>`; entitlements plist containing only that key was sufficient for a custom virtio-gpu device on macOS 27.2 (https://github.com/Quiet-Wolfe/vzgpu/blob/main/vzgpu.entitlements and README "Running"). No extra entitlement for custom devices is mentioned anywhere (Apple docs, WWDC page, Code-Hex PR, vzgpu). (Networking via `com.apple.vm.networking` is separate; VZNATNetworkDeviceAttachment needs none [U - not re-verified in this pass].)
- Not sandboxed command line tool: fine. vzgpu runs the whole VMM (provider delegate in-process) as one process.

### C4. virtio-fs layout the Linux driver expects [V, source = torvalds/linux master, tag listing shows v7.4-rc4, files fetched 2026-11-25]
- Device id 26 (`VIRTIO_ID_FS`); driver id_table `{ VIRTIO_ID_FS, VIRTIO_DEV_ANY_ID }`, https://github.com/torvalds/linux/blob/master/fs/fuse/virtio_fs.c (l.1281).
- Config space (uapi): `struct virtio_fs_config { __u8 tag[36]; __le32 num_request_queues; } __packed` = 40 bytes. https://github.com/torvalds/linux/blob/master/include/uapi/linux/virtio_fs.h . The spec adds a third field `le32 notify_buf_size` present only when VIRTIO_FS_F_NOTIFICATION is negotiated (spec source https://github.com/oasis-tcs/virtio-spec/blob/master/device-types/fs/description.tex). Tag: UTF-8, NUL padded, not NUL-terminated. Config space length is fixed once created (VZ `update` requires same size), so declare exactly 40 bytes.
- Queues: driver reads `num_request_queues` (0 => -EINVAL), truncates to nr_cpu_ids, `nvqs = 1 + num_request_queues`; queue 0 = "hiprio" (FUSE_FORGET, BATCH_FORGET, INTERRUPT only; must not be blocked by request queues), queues 1..n = "requests.N" (virtio_fs.c l.1006-1043). So `virtioQueueCount = 1 + num_request_queues`. Max `virtqueue size` used for max_pages computation from `virtqueue_get_vring_size(requests vq)` (l.1738-1786), so queue size matters for max FUSE write size.
- Feature bits: Linux `feature_table[] = {}` (l.1286): the driver accepts NO device-specific features, so VIRTIO_FS_F_NOTIFICATION (bit 0) will never be negotiated by Linux master. Generic bits (VERSION_1, RING_PACKED, EVENT_IDX, INDIRECT_DESC...) are handled by the transport; VZ always sets VERSION_1 and "a few" others internally; vzgpu observed packed ring (bit 34) negotiated by default.
- Notification queue / server-to-guest FUSE notifications: spec has them (queue index 1 only when the feature is set; notify buffers of `notify_buf_size`), but the Linux driver upstream does not implement them: the master source has no notification queue or feature bit (grep for "notif" finds only virtqueue_notify and a stale comment "Allocate fuse_dev for hiprio and notification queues" at l.1637). `git log` of virtio_fs.c shows no notification commit [V as far as 100 recent commits]. Therefore no server->guest FUSE_NOTIFY_* (INVAL_INODE, INVAL_ENTRY...) over virtiofs on stock Linux [V for master; older kernels not checked].
- DAX window: shared memory region id `VIRTIO_FS_SHMCAP_ID_CACHE` = 0 (virtio-pci SHM capability), looked up with `virtio_get_shm_region(vdev, &cache_reg, 0)`; absent => "No cache capability" and DAX is simply off (virtio_fs.c l.1119-1150). In master it sits behind `CONFIG_FUSE_VDAX` (new "vdax" implementation: mount option `dax=always|never|inode`, commit 2026-11-10 "fuse: advertise support for DAX mappings"); older kernels used `CONFIG_FUSE_DAX`/`-o dax` [U exact version boundary, not checked]. Map to VZ: `VZVirtioSharedMemoryRegionConfiguration(regionID: 0, size: N)`; mapping granularity = host page size 16 KiB on Apple silicon (pointer, offset, size all aligned; vzgpu README) while Linux DAX/FUSE_SETUPMAPPING works in 4 KiB (guest) pages/2 MiB-aligned chunks historically => a granularity mismatch to design for [inference; the FUSE-side alignment rules were not read].
- Whether VZ exposes the custom device as virtio-pci: Apple's pages say PCI class/subclass must be configured for discovery and the WWDC talk says "PCI class and subclass", the guest in vzgpu/Code-Hex tests sees them as PCI virtio devices (Linux virtio_gpu / hwrng bound). Shared memory regions are therefore SHM caps on virtio-pci [inference; no page states "virtio-pci" literally] [U].

## Unverified / to test first (checklist for the engineer)
1. deviceID 26 accepted by validateWithError and by the guest (16 and 4 are known OK; 26 untested). Does an additional VZVirtioFileSystemDeviceConfiguration with the same tag coexist? [U]
2. Whether `returnToQueue()` / `write()` are safe from non-device-queue threads (no Apple statement; all known implementations dispatch back to the device queue).
3. Queue size and event-idx/packed behaviour: queueSize is read-only; VZ negotiated packed ring in vzgpu.
4. Max `virtioQueueCount`, max region size/count (`maximumAllowedSharedMemoryRegionCount` value not documented; 8 GiB region accepted in vzgpu).
5. Whether mapMemory accepts a pointer from `mmap(MAP_SHARED, fd)` of a regular file (vzgpu used virglrenderer memory and POSIX shm only) and what happens on file truncation (SIGBUS in VMM) [U].
6. Latency per kick: none published [U]; measure with a no-op FUSE_INIT/GETATTR loop.
7. Apple release notes for macOS 27 (https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes) : search snippet showed no Virtualization entry in beta 7 notes; not read in full [U].
