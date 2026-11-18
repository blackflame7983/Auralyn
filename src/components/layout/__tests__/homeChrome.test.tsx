import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { syncLocalStateFromProfile } from '@/api/presets';
import { AppShell } from '../AppShell';

vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({ busy: false, label: '更新の確認', description: '', checkUpdates: vi.fn() }), UpdateGuide: () => null }));
import { actionWord, ChannelAction } from '@/components/features/Home/ChannelAction';
import { deriveHomeChrome } from '../homeChrome';
import { NoticeLane } from '../NoticeLane';
import { focusOutputGain, OutputGainControl } from '../OutputGainControl';

vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: () => null }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({
  useVoiceQuick: () => ({ stats: {}, noiseOn: true, chainOn: true, preset: 'broadcast', shownAmount: 50 }),
  NoiseSwitch: () => null, NoiseQuick: () => null, BuiltinSwitch: () => null, BuiltinQuick: () => null,
  BuiltinAmount: () => null, BuiltinPresets: () => null, ToneGuide: () => null,
}));

afterEach(() => { cleanup(); });

it('deriveHomeChrome は設定の有無だけで比較の出し分けを決める', () => {
  expect(deriveHomeChrome({ configured: false })).toEqual({ kind: 'setup', footer: { compare: 'whileActive' } });
  expect(deriveHomeChrome({ configured: true })).toEqual({ kind: 'daily', footer: { compare: 'always' } });
});

it('空の操作名は受け取らない', () => {
  expect(() => actionWord('')).toThrow(/blank/);
  expect(() => actionWord('   ')).toThrow(/blank/);
  const word = actionWord('音量チェック');
  const view = render(<ChannelAction word={word} />);
  const button = screen.getByRole('button', { name: '音量チェック' });
  expect([...button.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent === '音量チェック')).toBe(true);
  view.unmount();
});

it('設定済みホームの出力音量は本文の外に1つだけで、本番帯にはそのボタンがない', () => {
  render(<AppShell onOpenOBSSettings={vi.fn()} onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
    onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
    currentHost="WASAPI" currentInput="Mic" currentOutput="Out" isEngineRunning engineProcessReady>
    <p>rack</p>
  </AppShell>);
  const sliders = screen.getAllByRole('slider', { name: '出力音量' });
  expect(sliders).toHaveLength(1);
  expect(sliders[0].closest('main')).toBeNull();
  const column = sliders[0].closest('aside');
  expect(column).toHaveAttribute('aria-label', '本番中の操作');
  expect(document.querySelector('footer')).toBeNull();
  expect(column).toContainElement(screen.getByRole('button', { name: '緊急ミュート' }));
  const strip = screen.getByRole('region', { name: 'いまの状態' });
  expect(strip.querySelector('button[aria-label="出力音量"]')).toBeNull();
  expect(screen.getAllByRole('switch', { name: 'VSTを外して比較' })).toHaveLength(1);
});

it('音量ゼロの移動先は出力音量で、既存の案内表示を付ける', () => {
  vi.useFakeTimers();
  try {
    render(<OutputGainControl />);
    focusOutputGain();
    const slider = screen.getByRole('slider', { name: '出力音量' });
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('data-attention', '');
  } finally { vi.useRealTimers(); }
});

it('プロファイルの適用で出力音量が同期されると、表示だけが追従し、音量の設定や自動調整は再送しない', async () => {
  render(<OutputGainControl />);
  await act(async () => {});
  const before = vi.mocked(invoke).mock.calls.length;
  act(() => syncLocalStateFromProfile({ appliedCategories: ['audioConfig'], skippedCategories: [], missingDevices: [], missingPlugins: [], needsEngineRestart: false,
    appliedAudioConfig: { host: 'WASAPI', inputDevice: 'Mic', outputDevice: 'Out', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1], inputGainDb: 0, masterGainDb: -6.020599913279624 } }));
  expect(screen.getByRole('slider', { name: '出力音量' })).toHaveAttribute('aria-valuenow', '50');
  await act(async () => {});
  expect(vi.mocked(invoke).mock.calls.slice(before).filter(([command]) => command === 'set_output_gain' || command === 'auto_gain')).toEqual([]);
});

it('出力音量の操作部品を2つマウントすると開発時とテストで失敗する', () => {
  expect(() => render(<><OutputGainControl /><OutputGainControl /></>)).toThrow(/already mounted/);
});

it('通知行は先頭だけでなく表示中の全通知と間隔の高さを確保する', async () => {
  const { container } = render(<NoticeLane />);
  await act(async () => {
    toast('届きました', { id: 'home-notice-lane' });
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  const toaster = container.querySelector<HTMLElement>('[data-sonner-toaster]');
  expect(toaster).not.toBeNull();
  const notification = toaster!.querySelector<HTMLElement>('[data-sonner-toast]')!;
  Object.defineProperty(notification, 'offsetHeight', { value: 48 });
  const second = notification.cloneNode(true) as HTMLElement;
  Object.defineProperty(second, 'offsetHeight', { value: 64 });
  await act(async () => { toaster!.append(second); });
  expect(container.querySelector('.notice-lane')).toHaveStyle({ minHeight: '126px' });
  await act(async () => { second.remove(); });
  expect(container.querySelector('.notice-lane')).toHaveStyle({ minHeight: '48px' });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

it('操作名の隠蔽、通知の置き場所、舞台の伸びをソースに残さない', () => {
  // 数百ファイルを走査するため、ファイルごとに expect を作らず、違反を集めて最後に1回だけ確かめる。
  const toasterImport = new RegExp(String.raw`import\s*\{[^}]*\bToaster\b[^}]*\}\s*from\s*['"]sonner['"]`);
  const violations: string[] = [];
  const paths = filesUnder('src').filter(path => /\.(tsx?|css)$/.test(path));
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    if (source.includes('live-' + 'action-label')) violations.push(`${path}: 隠蔽用の操作名クラスが残っている`);
    if (!path.endsWith('NoticeLane.tsx') && source.includes('Toaster')) {
      if (source.includes('<' + 'Toaster')) violations.push(`${path}: Toaster を NoticeLane の外で描いている`);
      if (toasterImport.test(source)) violations.push(`${path}: Toaster を NoticeLane の外で読み込んでいる`);
    }
    if (!path.endsWith('.css')) continue;
    for (const block of source.split('}')) {
      const [selector = '', body = ''] = block.split('{');
      if (/\.live-stage\b|\.live-strip\b/.test(selector) && /flex-grow\s*:/.test(body)) violations.push(`${path} ${selector}: 舞台が flex-grow で伸びる`);
      if (/(live-action|channel-actions|action-word)/.test(selector) && /display\s*:\s*none|font-size\s*:\s*0/.test(body)) {
        violations.push(`${path} ${selector}: 操作名を隠している`);
      }
    }
  }
  expect(violations).toEqual([]);
});
