import { expect, test } from "bun:test"
import { createAudioDialogWaits } from "../audio-dialogs.ts"

test("canceling our wait settles before the host and ignores late approval", async () => {
  const dialogs = createAudioDialogWaits()
  let approve: (value: boolean) => void = () => {}
  const host = new Promise<boolean>((resolve) => {
    approve = resolve
  })
  const waiting = dialogs.run(() => host)
  dialogs.cancel()
  expect(await waiting).toBeUndefined()
  approve(true)
  await host
  expect(await waiting).toBeUndefined()
  expect(await dialogs.run(async () => "fresh selection")).toBe(
    "fresh selection",
  )
})

test("late host rejection after cancellation is handled, but current dialog failures remain visible", async () => {
  const dialogs = createAudioDialogWaits()
  let reject: (error: Error) => void = () => {}
  const host = new Promise<boolean>((_, fail) => {
    reject = fail
  })
  const waiting = dialogs.run(() => host)
  dialogs.cancel()
  reject(new Error("late host failure"))
  expect(await waiting).toBeUndefined()
  await expect(
    dialogs.run(async () => {
      throw new Error("current failure")
    }),
  ).rejects.toThrow("current failure")
})
