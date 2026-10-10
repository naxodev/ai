import { createLocalAudioPlugin } from "../audio-sidebar.tsx"

declare const LOCAL_MUSIC_AUDIO_SOCKET: string
// No default discovery or daemon spawn. The build must bind a separate socket.
export default createLocalAudioPlugin(
  typeof LOCAL_MUSIC_AUDIO_SOCKET === "string" ? LOCAL_MUSIC_AUDIO_SOCKET : "",
)
