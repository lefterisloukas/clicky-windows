import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "assets/icon",
    name: "Clicky",
    executableName: "clicky",
    // Bundle the local Kokoro TTS model (config + onnx/model_quantized.onnx).
    // Lands at process.resourcesPath/kokoro in the installed app — see
    // src/services/tts/kokoro.ts resolveModelDir(). Voices ship inside the
    // kokoro-js package itself, so they need no extra bundling.
    extraResource: ["resources/kokoro"],
  },
  makers: [
    new MakerSquirrel({
      name: "Clicky",
      setupExe: "Clicky-Setup.exe",
      setupIcon: "assets/icon.ico",
      noMsi: true,
    }),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
};

export default config;
