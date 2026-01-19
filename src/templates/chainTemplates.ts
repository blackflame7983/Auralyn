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
        description: "ノイズを消して、声を聴きやすく整える基本セットです。",
        slots: [
            {
                role: "noise_gate",
                label: "ノイズゲート",
                required: false,
                preferred: [{ nameIncludes: "gate" }, { nameIncludes: "noise" }],
                notes: "環境音（PCファンの音など）を消します。閾値（Threshold）を調整して、喋っていない時だけ音が消えるようにします。"
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
                notes: "叫んだ時などに音が割れるのを防ぎます。チェーンの最後に置き、Ceilingを-1.0dB程度に設定します。"
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
                notes: "最終的な音割れ防止です。"
            }
        ]
    },
    {
        id: "ASMR",
        name: "ASMR",
        description: "微細な音を拾いつつ、過大入力から耳を守る設定です。",
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
                notes: "不意の大きな音（耳へのダメージ）を防ぐため、入れることを推奨します。"
            }
        ]
    }
];
