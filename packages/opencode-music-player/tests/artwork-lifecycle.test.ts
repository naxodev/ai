import { expect, test } from "bun:test"
import {
  claimNativeArtworkOwnership,
  cleanupNativeArtwork,
  imageIdForArtwork,
  legacyImageIdForArtwork,
  legacyImageIdForResolvedArtwork,
} from "../artwork.tsx"
import { kittyImageId } from "../kitty-graphics.ts"
import { artworkCacheKey, artworkIdentityKey } from "../system-media.ts"

test("all tracks reuse one plugin-owned native image id", () => {
  expect(imageIdForArtwork("first-track")).toBe(
    imageIdForArtwork("replacement-track"),
  )
  expect(legacyImageIdForArtwork("first-track")).not.toBe(
    imageIdForArtwork("first-track"),
  )
})

test("an older mount cannot clean up a newer artwork owner", () => {
  const previous = claimNativeArtworkOwnership()
  expect(previous.isCurrent()).toBeTrue()

  const replacement = claimNativeArtworkOwnership()
  expect(previous.isCurrent()).toBeFalse()
  expect(replacement.isCurrent()).toBeTrue()

  let removals = 0
  cleanupNativeArtwork(previous, () => removals++)
  cleanupNativeArtwork(replacement, () => removals++)
  expect(removals).toBe(1)
})

test("upgrade cleanup targets the prior provider-based image id", () => {
  const identity = {
    uid: "provider-id",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration_ms: 180_000,
  }
  const legacyId = artworkIdentityKey(identity)
  const cacheId = artworkCacheKey(identity)

  expect(
    legacyImageIdForResolvedArtwork({ id: cacheId, legacy_id: legacyId }),
  ).toBe(kittyImageId(legacyId))
  expect(kittyImageId(legacyId)).not.toBe(kittyImageId(cacheId))
})
