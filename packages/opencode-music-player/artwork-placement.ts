/**
 * Pure planner for native Kitty album-artwork placement.
 *
 * Decides which cleanup/draw actions to run when slot geometry or image
 * identity changes. No I/O, no PNG bytes, no terminal writes.
 *
 * **Write-failure / `nextState` commit rule (Phase 2 executor):**
 * `nextState` is the state to commit **only after every planned action is
 * applied successfully**. On any failed write, the executor must keep the
 * previous `state` so the next frame retries from a known-good snapshot.
 * This module only proposes the post-success state; it does not simulate I/O.
 */

export type NativeArtworkPlacement = {
  imageId: number
  x: number
  y: number
  width: number
  height: number
}

export type NativeArtworkState = {
  /** Kitty image id currently believed transmitted (`0` = none). */
  transmitted: number
  /** Last successfully applied geometry, or `null`. */
  placement: NativeArtworkPlacement | null
}

export type NativeArtworkPlacementInput = {
  state: NativeArtworkState
  /** Desired Kitty image id for current artwork; ignored when clearing. */
  imageId: number
  /** Desired absolute cell geometry (caller applies any tmux offset). */
  x: number
  y: number
  width: number
  height: number
  /** Host can show native graphics. */
  kittySupported: boolean
  /** Container present, not destroyed, `width >= 1`, `height >= 1`. */
  slotValid: boolean
  /** Component tearing down. */
  disposed: boolean
}

export type NativeArtworkPlacementAction =
  | { type: "delete-image"; imageId: number }
  | { type: "delete-placement"; imageId: number }
  | {
      type: "transmit-and-display"
      imageId: number
      x: number
      y: number
      width: number
      height: number
    }
  | {
      type: "place"
      imageId: number
      placementId: number
      x: number
      y: number
      width: number
      height: number
    }

export type NativeArtworkPlacementPlan = {
  actions: NativeArtworkPlacementAction[]
  /**
   * Proposed state after successful apply of every action.
   * Do not commit on partial/failed writes — see module JSDoc.
   */
  nextState: NativeArtworkState
}

const CLEARED_STATE: NativeArtworkState = {
  transmitted: 0,
  placement: null,
}

/** Stable key matching the historical `imageId:x:y:width:height` string shape. */
export function placementKey(placement: NativeArtworkPlacement): string {
  return [
    placement.imageId,
    placement.x,
    placement.y,
    placement.width,
    placement.height,
  ].join(":")
}

function samePlacement(
  a: NativeArtworkPlacement | null,
  b: NativeArtworkPlacement,
): boolean {
  return a !== null && placementKey(a) === placementKey(b)
}

/**
 * Plan Kitty cleanup/draw actions for the next native-artwork frame.
 *
 * Decision table:
 * 1. disposed / unsupported / invalid slot → delete transmitted image (if any)
 * 2. different image id (incl. first paint) → delete old image, then transmit-and-display
 * 3. same image id, geometry changed → delete-placement then place
 * 4. same image id, same geometry → no-op
 */
export function planNativeArtworkPlacement(
  input: NativeArtworkPlacementInput,
): NativeArtworkPlacementPlan {
  const { state, imageId, x, y, width, height } = input
  const desired: NativeArtworkPlacement = { imageId, x, y, width, height }

  if (input.disposed || !input.kittySupported || !input.slotValid) {
    if (state.transmitted !== 0) {
      return {
        actions: [{ type: "delete-image", imageId: state.transmitted }],
        nextState: CLEARED_STATE,
      }
    }
    return { actions: [], nextState: state }
  }

  if (state.transmitted !== imageId) {
    const actions: NativeArtworkPlacementAction[] = []
    if (state.transmitted !== 0) {
      actions.push({ type: "delete-image", imageId: state.transmitted })
    }
    actions.push({
      type: "transmit-and-display",
      imageId,
      x,
      y,
      width,
      height,
    })
    return {
      actions,
      nextState: { transmitted: imageId, placement: desired },
    }
  }

  // Same image id.
  if (samePlacement(state.placement, desired)) {
    return { actions: [], nextState: state }
  }

  const actions: NativeArtworkPlacementAction[] = []
  // Applied placement or transmitted image → clear old placement first.
  if (state.placement !== null || state.transmitted !== 0) {
    actions.push({ type: "delete-placement", imageId })
  }
  actions.push({
    type: "place",
    imageId,
    placementId: imageId,
    x,
    y,
    width,
    height,
  })
  return {
    actions,
    nextState: { transmitted: imageId, placement: desired },
  }
}
