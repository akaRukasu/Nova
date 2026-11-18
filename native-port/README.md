# Voxcord 0.7.1 — native Rust client

Voxcord uses Rust and Slint for the complete desktop interface. It does not embed Discord's website, Electron or WebView2. The engine is a GPL-3.0-or-later fork of [Yapfast](https://github.com/yapfast/yapfast), pinned to `28174c7227e9b5a7a7dd222378086e88a62cbdb1`; `yapfast.patch` contains the complete changes, including branding and the Windows icon. Every build distributes the patched source and dependency notices alongside the portable executable.

## This build

- Profile cards use a compact banner, an activity section and a separate mutual-connections tab. Games and rich activities follow live member, friend and DM updates, including clearing stopped activities. The account's own rich activity is carried into its profile and profile editor. The status menu also opens the account's own profile directly.

- Test the selected camera and microphone in Voice & Video. Camera preview tries three capture formats without blocking the window. The microphone test plays the selected input back in real time on the selected output until stopped. Test capture is local and releases its devices when closed or when a call starts.
- In Discord calls, direct microphone mode is the default. Voice activity opens the microphone on the first block that crosses the sensitivity threshold. Push-to-talk is also available. Direct mode bypasses Voxcord's echo cancellation, denoising, automatic gain and leveling. Windows raw capture is requested when the device supports it.
- Hover over a server to see the participants in its visible voice rooms, using the Discord voice states that Voxcord already has. Names and video or stream indicators update as voice states arrive.
- Open the personal soundboard from Voice & Video to import sounds, find clips on Myinstants, preview them and play them into the current Discord call. The soundboard controls open in the default browser. To use a phone on the same network, enable the remote and scan its QR code. Ctrl+Alt+N opens the soundboard by default. Global shortcuts can be captured and assigned to camera, mute, deafen, voice input mode, streamer mode, settings, leave call, stop sounds and individual clips. Voice actions also work when the main window has been released to the system tray.

- Replace the speech-bubble face with a segmented V signal mark. A dark violet app tile and lavender mark identify the Windows executable and installer; a monochrome version is used in the UI, with a separate lower-right unread badge in the tray. The ICO contains 16, 20, 24, 32, 40, 48, 64, 128 and 256 px images.

- Preserve a camera's RTP reassembly when subscriptions change or op 12 repeats. Restart only the camera that was hidden/replaced; periodically request an initial keyframe and request another after a decoder error.
- Migrate existing profiles to a quiet taskbar once. Flashing remains an explicit opt-in, and turning it off cancels an existing attention request.
- Measure FPS from complete frames sent through UDP rather than the selected preset; show the target separately. Skip missed capture slots instead of catching them up in bursts. Actual size, encoder, measured bitrate, target bitrate and retransmissions remain visible in call connection details.
- Apply the Voxcord name and vector mark to the native window, UI copy, tray, executable, portable launcher and Windows installer. Retain the earlier NovaCord Native data directory and credential namespace to preserve linked accounts. The installer's stable AppId also allows upgrading the previous native test build.
- Retain native Discord soundboard search, messages, servers, DMs, cameras, voice and Go Live from the engine.

- Choose French or English in Appearance. French translations are bundled in the native executable. Native extensions include silent typing, clean links, replies without mentions, blocked-message hiding and a streamer mode that suspends desktop notifications and message notification sounds.
- The personal soundboard loads the account’s server catalogue on demand and keeps imports, categories, favorites, colors, volumes and phone pairing in the same controller.
- Choose Capture sound for screens, windows and camera shares. Window sharing captures the selected application’s process tree on Windows. Changing sources updates the audio scope after the new source produces a frame. Disabling sound stops its capture.

## Verification

The workflow builds the Windows application and test executables, runs camera subscription/reassembly tests, RTP tests and the screen media tests on Windows, then installs the EXE, runs its smoke test and checks that a native window opens. These are automated regression/startup checks. They do not prove successful multi-person calls or physical camera/audio behavior on a user's machine.

Download the `Voxcord-Windows-Setup` artifact from the successful workflow run and extract `Voxcord-Setup.exe`. The `Voxcord-portable-and-source` artifact contains the portable version and corresponding source.

## Logo assets

`voxcord.svg` is the full application icon; `voxcord-mark.svg` is the transparent monochrome symbol. Both share the same two paths. The engine patch includes these SVGs and the Windows ICO. To regenerate the ICO after changing the application SVG, use the engine's `scripts/make-windows-icon` (ImageMagick). Keep the monochrome viewBox at 24 units so the tray unread badge stays aligned.
