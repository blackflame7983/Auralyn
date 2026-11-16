export interface Plugin {
    id: string;
    name: string;
    path: string;
    vendor: string;
    version: string;
    enabled: boolean;
    hasEditor: boolean;
    muted: boolean;
    gain: number;
    classId?: string;
    channelLayout?: 'stereo' | 'mono' | 'monoToStereo';
}
