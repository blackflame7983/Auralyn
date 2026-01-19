# implementation_plan.md

# Phase 1: Reliability & Localization Update

## Goal Description
Implement "Phase 1: Reliability Improvement" from the UI/UX Critique.
This phase focuses on removing language barriers, establishing trust through consistent design (Material Symbols), and preventing "broadcast accidents" with a Panic Button.

## User Review Required
> [!IMPORTANT]
> **Icon Migration**: We are completely replacing `lucide-react` with `Material Symbols`. This will touch almost every UI component.
> **Panic Button**: This requires backend support (or a dummy implementation for now) to bypass audio processing.

## Proposed Changes

### 1. Dependency Management
#### [NEW] `react-icons`
- Install `react-icons` to access Material Symbols (md/rounded).
- Uninstall `lucide-react` after migration is complete.

### 2. Icon Replacement (Lucide -> Material Symbols)
Replace all instances of `lucide-react` icons with `react-icons/md` (Material Design Icons).
We will generally use the "Rounded" or "Outlined" variants if available in `Md` prefix (usually `MdOutline...` or standard `Md`). Let's stick to standard `Md` or `MdOutline` for consistency. *Actually, `react-icons` Md set usually corresponds to the filled/standard set. `MdOutline` is also available.*
**Decision**: Use `MdOutline...` (or `Md...` if outline not available) for a cleaner look, or `Md...` if we want solid. Let's aim for **Rounded** style if possible (`MdRounded...`) or standard `Md` which often looks cleaner. Let's use `Md` prefix icons which are standard.

#### Components to Update:
- `src/components/layout/Header.tsx` (Settings, Help, Theme, etc.)
- `src/components/layout/AppShell.tsx`
- `src/components/features/AudioSettings/AudioSettingsModal.tsx`
- `src/components/features/SetupWizard/SetupWizardModal.tsx`
- `src/components/features/Guide/OBSGuideModal.tsx`
- `src/components/features/PluginRack/PluginList.tsx`
- `src/components/features/PluginRack/PluginCard.tsx`
- `src/components/features/PluginBrowser/PluginBrowserModal.tsx`
- `src/components/features/DeviceStatus/DeviceStatus.tsx`
- `src/components/features/Presets/PresetManagerModal.tsx`

### 3. Localization & Text Improvements
Replace English text and technical terms with user-friendly Japanese.

#### [MODIFY] `src/App.tsx`
- Toast messages (File drop, Auto-start) -> Japanese.

#### [MODIFY] `src/components/features/AudioSettings/AudioSettingsModal.tsx`
- Labels: `Host`, `Input`, `Output`, `Buffer Size`, `Sample Rate` -> Japanese.

#### [MODIFY] `src/components/features/PluginRack/PluginCard.tsx`
- `EDIT`, `BYPASS` labels -> Japanese icons/tooltips or Japanese text.

### 4. Panic Button Implementation
Add a global bypass switch in the Header.

#### [MODIFY] `src/components/layout/Header.tsx`
- Add "Panic / Global Bypass" button (distinct style, maybe red/orange when active).
- Connect to `audioApi.toggleGlobalBypass()` (need to verify if this API exists, otherwise use `toggleGlobalMute` for now or implement bypass). *Critique said "Bypass (Raw Audio)", but if we don't have bypass API yet, we might need to use Mute or implement Bypass in Rust.*
- *Note*: If `toggleGlobalBypass` is not in `audioApi`, I will check `src-tauri/src/lib.rs` and `ipc.rs`. If missing, I will stick to "Panic Mute" or strictly implement Bypass if backend allows. For this UI task, I will assume we might need to add it or use Mute as placeholder if backend changes are out of scope for "UI/UX" (but User said "Implement"). I will check `audioApi` definitions.

## Verification Plan

### Automated Tests
- Build should pass: `npm run tauri build` (or verify via `npm run tauri dev`).

### Manual Verification
- Check all modals for `??` (mojibake) removal.
- Verify all icons are consistent (Material style).
- Verify no English error messages appear when dropping invalid files.
- Verify Panic Button toggles state.
