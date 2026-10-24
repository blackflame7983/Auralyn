import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import type { EngineRuntimeStats, LatencyStageBreakdown } from '@/api/audio';
import { LatencyStageDetails } from '../LatencyStageDetails';
const stage = (patch: Partial<LatencyStageBreakdown> = {}): LatencyStageBreakdown => ({ schemaVersion:1,queryBasis:'queriedAtRuntimeStats',current:true,streamEpoch:'new:2',globalBypass:false,vstKnownSubtotalSamples:null,vstSubtotalOverflow:false,
    vst:[{id:'plugin-id',name:'My VST',state:'active',bypassed:false,muted:false,declaredSamples:0},{id:'missing',name:'Unavailable VST',state:'unavailable',bypassed:false,muted:false,declaredSamples:null}],
    nr:{enabled:true,configuredRateHz:384000,frameSamples:3840,framePeriodMs:10,modelRateHz:48000,modelFrameSamples:480,signalDelay:'unknown'},builtinVoiceEnabled:true,builtinReverbEnabled:true,builtinSignalDelay:'unknown',...patch });
const stats = (s: LatencyStageBreakdown | null) => ({latencyMetadata:{stageBreakdown:s},queueDiagnostics:{epoch:'new:2',state:'running'}} as EngineRuntimeStats);
afterEach(()=>{cleanup();vi.mocked(invoke).mockClear();});
it('申告0と未取得を区別し、384k NRフレーム時間と未知の信号遅延を別表示する',()=>{
    render(<LatencyStageDetails stats={stats(stage())} current />);
    expect(screen.getByText(/My VST:.*VST申告 0 sample/)).toBeInTheDocument();
    expect(screen.getByText(/Unavailable VST:.*VST申告 不明/)).toBeInTheDocument();
    expect(screen.getByText(/3840 frame \/ 384000 Hz \/ 10.00 ms/)).toBeInTheDocument();
    expect(screen.getByText(/wet履歴とdry\/wet混合の信号遅延は不明/)).toBeInTheDocument();
    expect(screen.getByText(/実測総遅延はありません/)).toBeInTheDocument();expect(invoke).not.toHaveBeenCalled();
});
it('旧DTO・null・停止・異なるepoch・未知schemaは現在の段別値へ昇格しない',()=>{
    const view=render(<LatencyStageDetails stats={stats(null)} current />);
    for(const s of [null,{...stage(),schemaVersion:9} as unknown as LatencyStageBreakdown,stage({streamEpoch:'old:1'}),stage({current:false})]){
        view.rerender(<LatencyStageDetails stats={stats(s)} current />);expect(screen.getByText('段別の現在情報なし')).toBeInTheDocument();expect(screen.queryByText(/3840 frame/)).not.toBeInTheDocument();
    }
    view.rerender(<LatencyStageDetails stats={stats(stage())} current={false}/>);expect(screen.queryByText(/3840 frame/)).not.toBeInTheDocument();
});
it('範囲外・NaNフレームは0や10msへ置換せず、過大VST配列は拒否する',()=>{
    const s=stage();s.nr.framePeriodMs=NaN;
    const view=render(<LatencyStageDetails stats={stats(s)} current/>);expect(screen.getByText(/NR分析フレーム.*不明/)).toBeInTheDocument();
    s.vst=Array.from({length:33},()=>s.vst[0]);view.rerender(<LatencyStageDetails stats={stats(s)} current/>);expect(screen.getByText('段別の現在情報なし')).toBeInTheDocument();
});
it('英語でも公開VST名を翻訳せずbypass/muteと照会時点の限界を示す',()=>{
    const s=stage({globalBypass:true});s.vst[0].state='muted';s.vst[0].muted=true;
    render(<LocaleProvider store={createLocaleStore(()=> 'en',()=>true)}><LatencyStageDetails stats={stats(s)} current/></LocaleProvider>);
    expect(screen.getByText(/My VST: Muted stage/)).toBeInTheDocument();expect(screen.getByText(/Global bypass retains its VST-only scope/)).toBeInTheDocument();expect(screen.getByText(/not an RT application ACK/)).toBeInTheDocument();expect(invoke).not.toHaveBeenCalled();
});
