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
import { mergeArtworkCompletion, type PlayerState } from "../types.ts"

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

test("late session artwork cannot overwrite a replacement recording or clean up its owner", () => {
  const oldOwner = claimNativeArtworkOwnership()
  const replacementOwner = claimNativeArtworkOwnership()
  const replacement: PlayerState = {
    is_playing: true,
    progress_ms: 1,
    fetched_at: 1,
    shuffle: false,
    repeat: "off",
    device: null,
    track: {
      id: "provider-b",
      uri: "system:b",
      name: "Replacement",
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
      artwork: null,
    },
  }
  const stale = mergeArtworkCompletion(replacement, {
    type: "artwork-completion",
    identity: {
      uid: "provider-a",
      title: "Original",
      artist: "Artist",
      album: "Album",
      duration_ms: 180_000,
    },
    artwork: { id: "stale", png_base64: "", accent: "", cells: [] },
    duration_ms: 180_000,
  })
  let removals = 0
  cleanupNativeArtwork(oldOwner, () => removals++)

  expect(stale).toBe(replacement)
  expect(replacementOwner.isCurrent()).toBeTrue()
  expect(removals).toBe(0)
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
