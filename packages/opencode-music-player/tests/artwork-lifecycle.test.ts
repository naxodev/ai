import { expect, test } from "bun:test"
import {
  claimNativeArtworkOwnership,
  cleanupNativeArtwork,
  imageIdForArtwork,
  legacyImageIdForArtwork,
} from "../artwork.tsx"

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
