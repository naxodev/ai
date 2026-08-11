import { expect, test } from "bun:test"
import {
  MusicSessionClientError,
  createMusicSessionClient,
} from "../session/client.ts"

test("explicit client requires a socket", async () => {
  await expect(
    createMusicSessionClient({
      socketPath: "",
      clientId: "x",
      hostKind: "test",
    }),
  ).rejects.toBeInstanceOf(MusicSessionClientError)
})
