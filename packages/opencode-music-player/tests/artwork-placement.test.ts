import { describe, expect, test } from "bun:test"
import {
  placementKey,
  planNativeArtworkPlacement,
  type NativeArtworkPlacement,
  type NativeArtworkPlacementInput,
  type NativeArtworkState,
} from "../artwork-placement.ts"

const geom = (
  imageId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): NativeArtworkPlacement => ({ imageId, x, y, width, height })

const emptyState = (): NativeArtworkState => ({
  transmitted: 0,
  placement: null,
})

const applied = (placement: NativeArtworkPlacement): NativeArtworkState => ({
  transmitted: placement.imageId,
  placement,
})

function plan(
  partial: Partial<NativeArtworkPlacementInput> & {
    state: NativeArtworkState
  },
) {
  const defaults = {
    imageId: 1,
    x: 0,
    y: 0,
    width: 24,
    height: 12,
    kittySupported: true,
    slotValid: true,
    disposed: false,
  }
  return planNativeArtworkPlacement({ ...defaults, ...partial })
}

describe("planNativeArtworkPlacement", () => {
  test("unchanged geometry yields no actions and keeps state", () => {
    const placement = geom(1, 10, 4, 24, 12)
    const state = applied(placement)
    const result = plan({
      state,
      imageId: 1,
      x: 10,
      y: 4,
      width: 24,
      height: 12,
    })

    expect(result.actions).toEqual([])
    expect(result.nextState).toEqual(state)
  })

  test("slot moved deletes placement then places at new cells", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({
      state,
      imageId: 1,
      x: 30,
      y: 8,
      width: 24,
      height: 12,
    })

    expect(result.actions).toEqual([
      { type: "delete-placement", imageId: 1 },
      {
        type: "place",
        imageId: 1,
        placementId: 1,
        x: 30,
        y: 8,
        width: 24,
        height: 12,
      },
    ])
    expect(result.nextState).toEqual({
      transmitted: 1,
      placement: geom(1, 30, 8, 24, 12),
    })
  })

  test("slot resized deletes placement then places with new span", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({
      state,
      imageId: 1,
      x: 10,
      y: 4,
      width: 32,
      height: 16,
    })

    expect(result.actions).toEqual([
      { type: "delete-placement", imageId: 1 },
      {
        type: "place",
        imageId: 1,
        placementId: 1,
        x: 10,
        y: 4,
        width: 32,
        height: 16,
      },
    ])
    expect(result.nextState).toEqual({
      transmitted: 1,
      placement: geom(1, 10, 4, 32, 16),
    })
  })

  test("repeated alternating geometries always clean up before draw", () => {
    const a = geom(1, 0, 0, 24, 12)
    const b = geom(1, 5, 3, 24, 12)

    const first = plan({
      state: emptyState(),
      imageId: a.imageId,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
    })
    expect(first.actions).toEqual([
      {
        type: "transmit-and-display",
        imageId: 1,
        x: 0,
        y: 0,
        width: 24,
        height: 12,
      },
    ])
    expect(first.nextState).toEqual(applied(a))

    const second = plan({
      state: first.nextState,
      imageId: b.imageId,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    })
    expect(second.actions[0]).toEqual({ type: "delete-placement", imageId: 1 })
    expect(second.actions).toContainEqual({
      type: "place",
      imageId: 1,
      placementId: 1,
      x: 5,
      y: 3,
      width: 24,
      height: 12,
    })
    expect(second.nextState).toEqual(applied(b))

    const third = plan({
      state: second.nextState,
      imageId: a.imageId,
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
    })
    expect(third.actions[0]).toEqual({ type: "delete-placement", imageId: 1 })
    expect(third.actions).toContainEqual({
      type: "place",
      imageId: 1,
      placementId: 1,
      x: 0,
      y: 0,
      width: 24,
      height: 12,
    })
    expect(third.nextState).toEqual(applied(a))
  })

  test("image id replaced deletes old image then transmits the new one", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({
      state,
      imageId: 2,
      x: 10,
      y: 4,
      width: 24,
      height: 12,
    })

    expect(result.actions).toEqual([
      { type: "delete-image", imageId: 1 },
      {
        type: "transmit-and-display",
        imageId: 2,
        x: 10,
        y: 4,
        width: 24,
        height: 12,
      },
    ])
    expect(result.nextState).toEqual({
      transmitted: 2,
      placement: geom(2, 10, 4, 24, 12),
    })
  })

  test("first paint transmits without delete", () => {
    const result = plan({
      state: emptyState(),
      imageId: 7,
      x: 2,
      y: 3,
      width: 24,
      height: 12,
    })

    expect(result.actions).toEqual([
      {
        type: "transmit-and-display",
        imageId: 7,
        x: 2,
        y: 3,
        width: 24,
        height: 12,
      },
    ])
    expect(result.nextState).toEqual({
      transmitted: 7,
      placement: geom(7, 2, 3, 24, 12),
    })
  })

  test("invalid slot deletes transmitted image and clears state", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({ state, slotValid: false })

    expect(result.actions).toEqual([{ type: "delete-image", imageId: 1 }])
    expect(result.nextState).toEqual(emptyState())
  })

  test("kitty unsupported deletes transmitted image and clears state", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({ state, kittySupported: false })

    expect(result.actions).toEqual([{ type: "delete-image", imageId: 1 }])
    expect(result.nextState).toEqual(emptyState())
  })

  test("disposed deletes transmitted image and clears state", () => {
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({ state, disposed: true })

    expect(result.actions).toEqual([{ type: "delete-image", imageId: 1 }])
    expect(result.nextState).toEqual(emptyState())
  })

  test("zero-size slot modeled as slotValid false deletes and clears", () => {
    // Caller sets slotValid=false when width < 1 || height < 1.
    const state = applied(geom(1, 10, 4, 24, 12))
    const result = plan({
      state,
      width: 0,
      height: 0,
      slotValid: false,
    })

    expect(result.actions).toEqual([{ type: "delete-image", imageId: 1 }])
    expect(result.nextState).toEqual(emptyState())
  })

  test("proposes nextState only for successful apply", () => {
    // Write-failure contract: nextState is the *proposed* post-success state.
    // The executor (Phase 2) must not commit it if any write fails; the planner
    // always returns the target geometry even though I/O might reject.
    const state = applied(geom(1, 0, 0, 24, 12))
    const result = plan({
      state,
      imageId: 1,
      x: 40,
      y: 20,
      width: 24,
      height: 12,
    })

    expect(result.actions.length).toBeGreaterThan(0)
    expect(result.nextState.placement).toEqual(geom(1, 40, 20, 24, 12))
    // Previous state remains distinct — executor keeps it on failed writes.
    expect(result.nextState).not.toEqual(state)
    expect(state.placement).toEqual(geom(1, 0, 0, 24, 12))
  })

  test("clear paths with no transmitted image are no-ops", () => {
    const state = emptyState()
    expect(plan({ state, disposed: true })).toEqual({
      actions: [],
      nextState: state,
    })
    expect(plan({ state, kittySupported: false })).toEqual({
      actions: [],
      nextState: state,
    })
    expect(plan({ state, slotValid: false })).toEqual({
      actions: [],
      nextState: state,
    })
  })

  test("same id with null placement still cleans up before place", () => {
    const state: NativeArtworkState = { transmitted: 1, placement: null }
    const result = plan({
      state,
      imageId: 1,
      x: 1,
      y: 2,
      width: 24,
      height: 12,
    })

    expect(result.actions).toEqual([
      { type: "delete-placement", imageId: 1 },
      {
        type: "place",
        imageId: 1,
        placementId: 1,
        x: 1,
        y: 2,
        width: 24,
        height: 12,
      },
    ])
  })

  test("placementKey matches historical colon-joined shape", () => {
    expect(placementKey(geom(42, 3, 5, 24, 12))).toBe("42:3:5:24:12")
  })
})
