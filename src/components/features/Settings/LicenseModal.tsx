import React, { useState, useEffect } from 'react';
import { Modal } from '../../ui/modal';
import { MdClose, MdDescription, MdCode } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';

// Import JSON data directly
import npmLicensesRaw from '../../../assets/licenses-npm.json';
import productNotice from '../../../../NOTICE.md?raw';
import productLicense from '../../../../LICENSE?raw';

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
                    licenseMissing: typeof val.licenses !== 'string' && !Array.isArray(val.licenses),
                    repository: val.repository,
                    source: 'NPM' as const,
                    text: val.licenseText || 'License text not included.',
                    textFallback: val.licenseText ? null : 'notIncluded',
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
            licenseMissing: !lib.license,
            repository: lib.repository,
            source: 'NPM' as const,
            text: licenses[lib.license] || 'License text not found.',
            textFallback: licenses[lib.license] ? null : 'notFound',
        };
    });
};

export const LicenseModal: React.FC<LicenseModalProps> = ({ isOpen, onClose }) => {
    const t = useMessages();
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedLib, setSelectedLib] = useState<any | null>(null);
    const [activeTab, setActiveTab] = useState<'product' | 'npm' | 'cargo'>('product');

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
                        licenseMissing: !item.license,
                        repository: item.repository,
                        source: 'Cargo' as const,
                        text: licenses[item.license] || 'License text not found.',
                        textFallback: licenses[item.license] ? null : 'notFound',
                    }));
                setCargoData(formatted);
            } catch (e) {
                console.warn("Cargo licenses not found", e);
            }
        };
        loadCargo();
    }, []);

    const npmList = formatNpmData(npmLicensesRaw);
    const displayList = activeTab === 'npm' ? npmList : activeTab === 'cargo' ? cargoData : [];

    const filteredList = displayList.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.license && item.license.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (!isOpen) return null;

    return (
        <Modal title={t('licenses.title')} onClose={onClose}>
        <div className="modal-overlay-base bg-overlay/50" onClick={onClose}>
            {/* Modal Content - stop propagation to prevent closing when clicking inside */}
            <div
                className="modal-surface-base max-w-4xl w-full h-[80vh] flex flex-col text-foreground bg-background"
                onClick={e => e.stopPropagation()}
            >

                {/* Header */}
                <div className="modal-header-base modal-header-muted grid grid-cols-[minmax(0,1fr)_auto] gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                    <h2 className="min-w-0 text-xl font-bold flex items-center gap-2">
                        <MdDescription className="w-6 h-6 shrink-0 text-primary" />
                        {t('licenses.heading')}
                    </h2>
                    {/* Tabs */}
                    <div role="group" aria-label={t('licenses.types')} className="col-span-2 row-start-2 flex flex-wrap gap-1 bg-muted rounded-lg p-1 md:col-span-1 md:col-start-2 md:row-start-1">
                        <button
                            onClick={() => setActiveTab('product')}
                            aria-pressed={activeTab === 'product'}
                            className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${activeTab === 'product' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            Auralyn
                        </button>
                        <button
                            onClick={() => setActiveTab('npm')}
                            aria-pressed={activeTab === 'npm'}
                            className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${activeTab === 'npm' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            {t('licenses.npm')}
                        </button>
                        <button
                            onClick={() => setActiveTab('cargo')}
                            aria-pressed={activeTab === 'cargo'}
                            className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${activeTab === 'cargo' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            {t('licenses.cargo')}
                        </button>
                    </div>
                    <button aria-label={t('licenses.close')} onClick={onClose} className="col-start-2 row-start-1 self-start p-2 hover:bg-muted rounded-full transition-colors md:col-start-3">
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                <div className="modal-body-base p-0 overflow-hidden flex">
                    {activeTab === 'product' ? (
                        <div className="flex-1 overflow-y-auto p-6 bg-muted/5">
                            <div className="max-w-3xl mx-auto whitespace-pre-wrap text-sm leading-relaxed select-text">
                                {`${productNotice}\n\n${productLicense}`}
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Left: List */}
                            <div className="w-1/3 border-r border-border flex flex-col bg-muted/10">
                                <div className="p-3 border-b border-border">
                                    <input
                                        type="text"
                                        placeholder={t('licenses.searchPlaceholder')}
                                        aria-label={t('licenses.search')}
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
                                                <span className="text-[10px] text-muted-foreground truncate max-w-[50%]">{item.licenseMissing ? t('licenses.unknown') : item.license}</span>
                                            </div>
                                        </button>
                                    ))}
                                    {filteredList.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('licenses.empty')}</p>}
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
                                                            title={t('licenses.repository')}
                                                            aria-label={t('licenses.repository')}
                                                        >
                                                            <MdCode className="w-5 h-5" />
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex gap-4 text-sm text-muted-foreground">
                                                <div className="flex items-center gap-1">
                                                    <span className="font-bold text-foreground">{t('licenses.license')}</span> {selectedLib.licenseMissing ? t('licenses.unknown') : selectedLib.license}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex-1 overflow-y-auto p-6 bg-muted/5 font-mono text-xs whitespace-pre-wrap leading-relaxed select-text">
                                            {selectedLib.textFallback === 'notIncluded' ? t('licenses.notIncluded') : selectedLib.textFallback === 'notFound' ? t('licenses.notFound') : selectedLib.text}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                                        <MdDescription className="w-16 h-16 mb-4 opacity-20" />
                                        <p>{t('licenses.select')}</p>
                                        <p className="text-sm mt-2 opacity-60">{t('licenses.selectHint')}</p>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
        </Modal>
    );
};
