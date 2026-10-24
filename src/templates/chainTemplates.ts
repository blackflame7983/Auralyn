import type { MessageKey } from '@/i18n/messages';
export type TemplateRole =
    | "noise_gate"
    | "compressor"
    | "deesser"
    | "eq"
    | "limiter"
    | "reverb";

export interface TemplateSlot {
    role: TemplateRole;
    required: boolean;
    label: string;
    preferred?: Array<{ vendor?: string; nameIncludes?: string }>;
    notes?: string;
}

export interface ChainTemplate {
    id: string;
    name: string;
    description: string;
    slots: TemplateSlot[];
}

export const CHAIN_TEMPLATES: ChainTemplate[] = [
    {
        id: "chatting",
        name: "雑談 (Just Chatting)",
        description: "持続ノイズを抑え、コンプで声を聴き取りやすく整える基本セットです。",
        slots: [
            {
                role: "noise_gate",
                label: "ノイズゲート",
                required: false,
                preferred: [{ nameIncludes: "gate" }, { nameIncludes: "noise" }],
                notes: "PCファンなどの持続ノイズを、喋っていないときに抑えます。閾値（Threshold）を調整して、無音時だけ効くようにします。"
            },
            {
                role: "compressor",
                label: "コンプレッサー",
                required: true,
                preferred: [{ nameIncludes: "comp" }, { nameIncludes: "la-2a" }, { nameIncludes: "1176" }],
                notes: "声の大小の差を縮めて、聞き取りやすくします。Ratioを4:1、Gain Reductionが-3dB〜-6dB動く程度にします。"
            },
            {
                role: "limiter",
                label: "リミッター",
                required: true,
                preferred: [{ nameIncludes: "limit" }, { nameIncludes: "maximiz" }],
                notes: "大きな声のピークを抑えるための調整例です。チェーンの最後に置き、Ceilingを-1.0dB程度に設定します。"
            }
        ]
    },
    {
        id: "singing",
        name: "歌枠 (Singing)",
        description: "歌声に艶を出し、オケに馴染ませるセットです。",
        slots: [
            {
                role: "eq",
                label: "イコライザー (EQ)",
                required: true,
                preferred: [{ nameIncludes: "eq" }, { nameIncludes: "filter" }],
                notes: "100Hz以下をカットし、2kHz〜4kHzを少し持ち上げると抜けが良くなります。"
            },
            {
                role: "compressor",
                label: "コンプレッサー",
                required: true,
                preferred: [{ nameIncludes: "comp" }, { nameIncludes: "la-2a" }],
                notes: "歌の抑揚を整えます。雑談より少し強めにかけるのが一般的です。"
            },
            {
                role: "reverb",
                label: "リバーブ",
                required: false,
                preferred: [{ nameIncludes: "verb" }, { nameIncludes: "room" }, { nameIncludes: "hall" }],
                notes: "空間の広がりを作ります。Send量（Mix）は控えめに、10%〜20%から始めましょう。"
            },
            {
                role: "limiter",
                label: "リミッター",
                required: true,
                preferred: [{ nameIncludes: "limit" }],
                notes: "ピークを抑えるために、Ceilingと入力レベルを調整します。音割れを必ず防げるものではありません。"
            }
        ]
    },
    {
        id: "ASMR",
        name: "ASMR",
        description: "ASMR向けにコンプとリミッターを並べる構成例です。音量制限や聴覚保護を保証するものではありません。",
        slots: [
            {
                role: "compressor",
                label: "コンプレッサー (弱め)",
                required: true,
                preferred: [{ nameIncludes: "comp" }],
                notes: "小さな音を持ち上げるために使います。Releaseは長めに設定します。"
            },
            {
                role: "limiter",
                label: "リミッター (保護)",
                required: true,
                preferred: [{ nameIncludes: "limit" }],
                notes: "Ceilingと入力レベルを確認し、小さい再生音量から試してください。機器の音量や耳の安全を保証するものではありません。"
            }
        ]
    }
];

// 表示keyは選択・自動割当用の既存template objectから分離する。
export const CHAIN_TEMPLATE_COPY: Readonly<Record<string, { name: MessageKey; description: MessageKey; slots: readonly { label: MessageKey; notes: MessageKey }[] }>> = {
    "chatting": { name: "templates.chatting.name", description: "templates.chatting.description", slots: [
        { label: "templates.chatting.slot0.label", notes: "templates.chatting.slot0.notes" },
        { label: "templates.chatting.slot1.label", notes: "templates.chatting.slot1.notes" },
        { label: "templates.chatting.slot2.label", notes: "templates.chatting.slot2.notes" },
    ] },
    "singing": { name: "templates.singing.name", description: "templates.singing.description", slots: [
        { label: "templates.singing.slot0.label", notes: "templates.singing.slot0.notes" },
        { label: "templates.singing.slot1.label", notes: "templates.singing.slot1.notes" },
        { label: "templates.singing.slot2.label", notes: "templates.singing.slot2.notes" },
        { label: "templates.singing.slot3.label", notes: "templates.singing.slot3.notes" },
    ] },
    "ASMR": { name: "templates.ASMR.name", description: "templates.ASMR.description", slots: [
        { label: "templates.ASMR.slot0.label", notes: "templates.ASMR.slot0.notes" },
        { label: "templates.ASMR.slot1.label", notes: "templates.ASMR.slot1.notes" },
    ] },
};
