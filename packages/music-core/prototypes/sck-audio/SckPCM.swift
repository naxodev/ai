// One bounded PCM decoder for feasibility and exclusion sinks. Never writes samples.
import CoreMedia
private func withSckPCM(_ buffer: CMSampleBuffer, strict: Bool,
    consume: (UnsafeMutablePointer<AudioBufferList>, Int, CMTime) throws -> Void) throws {
    guard CMSampleBufferIsValid(buffer), CMSampleBufferDataIsReady(buffer),
          let description = CMSampleBufferGetFormatDescription(buffer),
          let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
          format.mFormatID == kAudioFormatLinearPCM, format.mSampleRate == 48000,
          format.mChannelsPerFrame == 2, format.mBitsPerChannel == 32,
          format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
          format.mFormatFlags & kAudioFormatFlagIsPacked != 0,
          format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else { throw HelperError(reason: "format") }
    let count = CMSampleBufferGetNumSamples(buffer)
    let timestamp = CMSampleBufferGetPresentationTimeStamp(buffer)
    guard count > 0, count <= 16384, timestamp.isNumeric,
          CMTimeGetSeconds(timestamp).isFinite, CMTimeGetSeconds(timestamp) > 0 else { throw HelperError(reason: "clock") }
    let size = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size
    let storage = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { storage.deallocate() }
    storage.initializeMemory(as: UInt8.self, repeating: 0, count: size)
    let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
    list.pointee.mNumberBuffers = 2
    var needed = 0
    var block: CMBlockBuffer?
    _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &needed,
        bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: 0, blockBufferOut: nil)
    guard needed > 0, needed <= size else { throw HelperError(reason: "format") }
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &needed,
        bufferListOut: list, bufferListSize: needed, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, blockBufferOut: &block)
    guard status == noErr, needed <= size else { throw HelperError(reason: "format") }
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    guard buffers.count == 1 || buffers.count == 2,
          buffers.allSatisfy({ $0.mData != nil && Int($0.mDataByteSize) == count * Int($0.mNumberChannels) * 4 }),
          (buffers.count == 1 && buffers[0].mNumberChannels == 2) ||
          (buffers.count == 2 && buffers.allSatisfy({ $0.mNumberChannels == 1 })) else { throw HelperError(reason: "format") }
    if strict {
        for buffer in buffers {
            guard let data = buffer.mData else { throw HelperError(reason: "format") }
            let values = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: count * Int(buffer.mNumberChannels))
            guard values.allSatisfy({ $0.isFinite }) else { throw HelperError(reason: "format") }
        }
    }
    try withExtendedLifetime(block) { try consume(list, count, timestamp) }
}
