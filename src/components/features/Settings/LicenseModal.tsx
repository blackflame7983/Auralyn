import React, { useState, useEffect } from 'react';
import { MdClose, MdDescription, MdCode } from 'react-icons/md';
// Dialog component replaced by manual div overlay to match local components
// import { Dialog, DialogContent } from "../../ui/dialog";

// Import JSON data directly
import npmLicensesRaw from '../../../assets/licenses-npm.json';

interface LicenseModalProps {
    isOpen: boolean;
    onClose: () => void;
}



interface NormalizedLicenseData {
    licenses: Record<string, string>;
    libraries: any[];
}

// Helper to normalize NPM data
const formatNpmData = (data: typeof npmLicensesRaw) => {
    // Assert the data structure matches our new format
    const normalizedData = data as unknown as NormalizedLicenseData;
    const licenses = normalizedData.licenses || {};
    const libraries = normalizedData.libraries || [];

    // Fallback for old format if something goes wrong or transitional state
    if (!normalizedData.libraries && !normalizedData.licenses) {
        // This block handles the old 'nested object' format if needed, but we are overwriting it.
        // Let's assume the new format is present.
        // If libraries is empty but data keys exist, it might be old format.
        // But we just updated the generator, so let's stick to new format logic primarily.
        // We can do a quick check:
        if (Object.keys(data).length > 0 && !('libraries' in data)) {
            // Old format recovery (optional, but good for safety)
            return Object.entries(data).map(([key, value]) => {
                const val = value as any;
                const lastAt = key.lastIndexOf('@');
                const name = lastAt > 0 ? key.substring(0, lastAt) : key;
                const version = lastAt > 0 ? key.substring(lastAt + 1) : '';
                return {
                    id: key,
                    name: name,
                    version: version,
                    license: typeof val.licenses === 'string' ? val.licenses : (Array.isArray(val.licenses) ? val.licenses.join(', ') : 'Unknown'),
                    repository: val.repository,
                    source: 'NPM' as const,
                    text: val.licenseText || 'License text not included.'
                };
            });
        }
        return [];
    }

    return libraries.map((lib: any) => {
        return {
            id: lib.id,
            name: lib.name || lib.id, // NPM libs might encode name in ID, but our generator separates them now slightly differently? 
            // Actually our generator pushes: { id: pkgName, ...pkg, license: key }
            // pkgName in npm is name@version mostly? No, license-checker returns "name@version" as key.
            // So lib.id is "name@version".
            version: lib.version || lib.id.split('@').pop(),
            license: lib.license || 'Unknown',
            repository: lib.repository,
            source: 'NPM' as const,
            text: licenses[lib.license] || 'License text not found.'
        };
    });
};

export const LicenseModal: React.FC<LicenseModalProps> = ({ isOpen, onClose }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedLib, setSelectedLib] = useState<any | null>(null);
    const [activeTab, setActiveTab] = useState<'npm' | 'cargo'>('npm');

    // Load Cargo data state
    const [cargoData, setCargoData] = useState<any[]>([]);

    useEffect(() => {
        const loadCargo = async () => {
            try {
                // Dynamic import to avoid strict dependency on the file if it's missing/broken
                const module = await import('../../../assets/licenses-cargo.json');
                const data = module.default as unknown as NormalizedLicenseData;

                const licenses = data.licenses || {};
                const libraries = data.libraries || [];

                const formatted = libraries
                    .filter((item: any) => item.name !== 'vst-host-dummy-end')
                    .map((item: any) => ({
                        id: `${item.name}@${item.version}`,
                        name: item.name,
                        version: item.version,
                        license: item.license || 'Unknown',
                        repository: item.repository,
                        source: 'Cargo' as const,
                        text: licenses[item.license] || 'License text not found.'
                    }));
                setCargoData(formatted);
            } catch (e) {
                console.warn("Cargo licenses not found", e);
            }
        };
        loadCargo();
    }, []);

    const npmList = formatNpmData(npmLicensesRaw);
    const displayList = activeTab === 'npm' ? npmList : cargoData;

    const filteredList = displayList.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.license && item.license.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={onClose}>
            {/* Modal Content - stop propagation to prevent closing when clicking inside */}
            <div
                className="max-w-4xl w-full h-[80vh] flex flex-col overflow-hidden bg-background text-foreground rounded-xl shadow-2xl border border-border"
                onClick={e => e.stopPropagation()}
            >

                {/* Header */}
                <div className="p-4 border-b border-border flex justify-between items-center bg-muted/20">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                        <MdDescription className="w-6 h-6 text-primary" />
                        ライセンス情報 / OSS Attribution
                    </h2>
                    {/* Tabs */}
                    <div className="flex bg-muted rounded-lg p-1">
                        <button
                            onClick={() => setActiveTab('npm')}
                            className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${activeTab === 'npm' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            NPM (Frontend)
                        </button>
                        <button
                            onClick={() => setActiveTab('cargo')}
                            className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${activeTab === 'cargo' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            Cargo (Backend)
                        </button>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-muted rounded-full transition-colors">
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Left: List */}
                    <div className="w-1/3 border-r border-border flex flex-col bg-muted/10">
                        <div className="p-3 border-b border-border">
                            <input
                                type="text"
                                placeholder="検索 / Search..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {filteredList.map(item => (
                                <button
                                    key={item.id}
                                    onClick={() => setSelectedLib(item)}
                                    className={`w-full text-left px-4 py-3 border-b border-border/50 hover:bg-muted/50 transition-colors ${selectedLib?.id === item.id ? 'bg-primary/10 border-l-4 border-l-primary' : 'border-l-4 border-l-transparent'}`}
                                >
                                    <div className="font-bold truncate text-sm">{item.name}</div>
                                    <div className="flex justify-between items-center mt-1">
                                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{item.version}</span>
                                        <span className="text-[10px] text-muted-foreground truncate max-w-[50%]">{item.license}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Right: Detail */}
                    <div className="flex-1 flex flex-col bg-background h-full overflow-hidden">
                        {selectedLib ? (
                            <div className="flex flex-col h-full">
                                <div className="p-6 border-b border-border">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="text-2xl font-bold flex items-center gap-2">
                                            {selectedLib.name}
                                            <span className="text-sm font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">v{selectedLib.version}</span>
                                        </h3>
                                        <div className="flex gap-2">
                                            {selectedLib.repository && (
                                                <a
                                                    href={typeof selectedLib.repository === 'string' ? selectedLib.repository.replace('git+', '').replace('.git', '') : '#'}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="p-2 text-muted-foreground hover:text-primary transition-colors"
                                                    title="Repository"
                                                >
                                                    <MdCode className="w-5 h-5" />
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex gap-4 text-sm text-muted-foreground">
                                        <div className="flex items-center gap-1">
                                            <span className="font-bold text-foreground">License:</span> {selectedLib.license}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-6 bg-muted/5 font-mono text-xs whitespace-pre-wrap leading-relaxed select-text">
                                    {selectedLib.text}
                                </div>
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                                <MdDescription className="w-16 h-16 mb-4 opacity-20" />
                                <p>左側のリストからライブラリを選択してください</p>
                                <p className="text-sm mt-2 opacity-60">Select a library to view license details</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
