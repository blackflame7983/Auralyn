import type { MessageKey } from '@/i18n/messages';
import { useMessages } from '@/i18n/LocaleProvider';
import { Modal } from '../../ui/modal';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { VstPlugin } from '../../../api/audio';
import { Panel } from '../../ui/Panel/Panel';
import { MdStar, MdStarBorder, MdHistory, MdGridView, MdClose, MdSearch, MdRefresh, MdWarning } from 'react-icons/md';

interface PluginBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPluginSelect: (plugin: VstPlugin) => void;
  plugins: VstPlugin[];
  isLoading: boolean;
  error?: string | null;
  onScan: () => void;
}

type TabType = 'all' | 'favorites' | 'recent';

const STORAGE_KEYS = {
  favorites: 'vst_host_plugin_favorites',
  recent: 'vst_host_plugin_recent',
};

const MAX_RECENT = 10;

// 既存の日本語カテゴリIDは選択・集計用のまま保ち、表示だけを切り替える。
const SIMPLE_CATEGORY_KEYS: Record<string, MessageKey> = {
  '未分類': 'pluginBrowser.category.uncategorized', 'ダイナミクス': 'pluginBrowser.category.dynamics',
  'EQ/フィルター': 'pluginBrowser.category.eqFilter', 'リバーブ/ディレイ': 'pluginBrowser.category.reverbDelay',
  'ディストーション': 'pluginBrowser.category.distortion', 'モジュレーション': 'pluginBrowser.category.modulation',
  'ツール': 'pluginBrowser.category.tools', 'ノイズ除去': 'pluginBrowser.category.noiseReduction',
  'インストゥルメント': 'pluginBrowser.category.instrument', 'エフェクト (その他)': 'pluginBrowser.category.otherFx',
};

function readStoredPaths(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

// Map VST3 category strings to user-friendly Japanese labels
const CATEGORY_LABELS: Record<string, MessageKey> = {
  'Fx': 'pluginBrowser.category.fx',
  'Fx|Dynamics': 'pluginBrowser.category.dynamicsDetail',
  'Fx|EQ': 'pluginBrowser.category.eq',
  'Fx|Reverb': 'pluginBrowser.category.reverb',
  'Fx|Delay': 'pluginBrowser.category.delay',
  'Fx|Distortion': 'pluginBrowser.category.distortion',
  'Fx|Filter': 'pluginBrowser.category.filter',
  'Fx|Modulation': 'pluginBrowser.category.modulation',
  'Fx|Mastering': 'pluginBrowser.category.mastering',
  'Fx|Spatial': 'pluginBrowser.category.spatial',
  'Fx|Restoration': 'pluginBrowser.category.restoration',
  'Fx|Analyzer': 'pluginBrowser.category.analyzer',
  'Fx|Tools': 'pluginBrowser.category.tools',
  'Fx|Network': 'pluginBrowser.category.network',
  'Fx|Generator': 'pluginBrowser.category.generator',
  'Instrument': 'pluginBrowser.category.instrument',
  'Instrument|Synth': 'pluginBrowser.category.synth',
  'Instrument|Sampler': 'pluginBrowser.category.sampler',
  'Instrument|Drum': 'pluginBrowser.category.drums',
};

function getCategoryLabel(category: string | undefined, t: ReturnType<typeof useMessages>): string {
  if (!category) return t('pluginBrowser.category.uncategorized');
  // Try exact match first
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)) return t(CATEGORY_LABELS[category]);
  // Try prefix match
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    if (category.startsWith(key)) return t(label);
  }
  // Fallback
  if (category.startsWith('Fx')) return t('pluginBrowser.category.otherFx');
  if (category.startsWith('Instrument')) return t('pluginBrowser.category.instrument');
  return category || t('pluginBrowser.category.uncategorized');
}

function getSimpleCategory(category: string): string {
  // Group into major categories for filtering
  if (!category) return '未分類';
  if (category.includes('Dynamics') || category.includes('Compressor')) return 'ダイナミクス';
  if (category.includes('EQ') || category.includes('Filter')) return 'EQ/フィルター';
  if (category.includes('Reverb') || category.includes('Delay')) return 'リバーブ/ディレイ';
  if (category.includes('Distortion')) return 'ディストーション';
  if (category.includes('Modulation')) return 'モジュレーション';
  if (category.includes('Analyzer') || category.includes('Tools')) return 'ツール';
  if (category.includes('Restoration')) return 'ノイズ除去';
  if (category.startsWith('Instrument')) return 'インストゥルメント';
  if (category.startsWith('Fx')) return 'エフェクト (その他)';
  return '未分類';
}

export const PluginBrowserModal: React.FC<PluginBrowserModalProps> = ({
  isOpen,
  onClose,
  onPluginSelect,
  plugins: suppliedPlugins,
  isLoading,
  error,
  onScan
}) => {
    const t = useMessages();
  // スキャナーや旧キャッシュで省略されたメタデータを、すべてのタブで安全に扱う。
  const plugins = useMemo(() => suppliedPlugins.map(plugin => ({
    ...plugin,
    name: typeof plugin.name === 'string' ? plugin.name : '',
    vendor: typeof plugin.vendor === 'string' ? plugin.vendor : '',
    category: typeof plugin.category === 'string' ? plugin.category : '',
  })), [suppliedPlugins]);
  const displayPluginName = (plugin: VstPlugin) => plugin.name || t('pluginBrowser.unknownName');
  const categoryLabel = (id: string) => Object.prototype.hasOwnProperty.call(SIMPLE_CATEGORY_KEYS, id) ? t(SIMPLE_CATEGORY_KEYS[id]) : id;
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  // Load from localStorage
  useEffect(() => {
    setFavorites(readStoredPaths(STORAGE_KEYS.favorites));
    setRecentPaths(readStoredPaths(STORAGE_KEYS.recent));
  }, []);

  // Build category list from plugins
  const categories = useMemo(() => {
    const catSet = new Map<string, number>();
    for (const p of plugins) {
      const cat = getSimpleCategory(p.category);
      catSet.set(cat, (catSet.get(cat) || 0) + 1);
    }
    return Array.from(catSet.entries())
      .sort((a, b) => b[1] - a[1]) // Sort by count desc
      .map(([name, count]) => ({ name, count }));
  }, [plugins]);

  // Save favorites to localStorage
  const saveFavorites = (newFavorites: string[]) => {
    setFavorites(newFavorites);
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(newFavorites));
  };

  // Save recent to localStorage
  const saveRecent = (newRecent: string[]) => {
    setRecentPaths(newRecent);
    localStorage.setItem(STORAGE_KEYS.recent, JSON.stringify(newRecent));
  };

  const toggleFavorite = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (favorites.includes(path)) {
      saveFavorites(favorites.filter(f => f !== path));
    } else {
      saveFavorites([...favorites, path]);
    }
  };

  const handlePluginSelect = (plugin: VstPlugin) => {
    // Add to recent
    const newRecent = [plugin.path, ...recentPaths.filter(p => p !== plugin.path)].slice(0, MAX_RECENT);
    saveRecent(newRecent);
    onPluginSelect(plugin);
  };

  const handlePluginKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, plugin: VstPlugin) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePluginSelect(plugin);
    }
  };

  useEffect(() => {
    if (isOpen && plugins.length === 0) {
      onScan();
    }
  }, [isOpen]);

  // Reset category filter when switching tabs
  useEffect(() => {
    if (activeTab !== 'all') {
      setSelectedCategory(null);
    }
  }, [activeTab]);

  // Filter plugins based on search, tab, and category
  const getFilteredPlugins = () => {
    const query = searchQuery.toLowerCase();
    const matchesSearch = (plugin: VstPlugin) =>
      [plugin.name, plugin.vendor, plugin.category].some(value => value.toLowerCase().includes(query));
    let filtered = plugins.filter(matchesSearch);

    // Category filter
    if (selectedCategory && activeTab === 'all') {
      filtered = filtered.filter(p => getSimpleCategory(p.category) === selectedCategory);
    }

    if (activeTab === 'favorites') {
      filtered = filtered.filter(p => favorites.includes(p.path));
    } else if (activeTab === 'recent') {
      const recentPlugins = recentPaths
        .map(path => plugins.find(p => p.path === path))
        .filter((p): p is VstPlugin => p !== undefined);
      filtered = recentPlugins.filter(matchesSearch);
    }

    return filtered;
  };

  const filteredPlugins = getFilteredPlugins();

  if (!isOpen) return null;

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: t('pluginBrowser.tab.all'), icon: <MdGridView className="w-3 h-3" /> },
    { id: 'recent', label: t('pluginBrowser.tab.recent'), icon: <MdHistory className="w-3 h-3" /> },
    { id: 'favorites', label: t('pluginBrowser.tab.favorites'), icon: <MdStar className="w-3 h-3" /> },
  ];

  return (
    <Modal title={t('pluginBrowser.title')} onClose={onClose}>
        <div className="modal-overlay-base z-[100]">
      <Panel className="w-[calc(100vw-2rem)] max-w-[700px] h-[calc(100vh-3rem)] max-h-[550px] flex flex-col p-4 sm:p-6 shadow-2xl border border-primary/20 relative overflow-hidden bg-card text-card-foreground">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-foreground tracking-tight">
            {t('pluginBrowser.title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('pluginBrowser.close')}
            className="p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div role="group" aria-label={t('pluginBrowser.filter')} className="flex gap-1 mb-4 p-1 bg-muted rounded-lg">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${activeTab === tab.id
                ? 'bg-background text-primary shadow-sm font-bold'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'favorites' && favorites.length > 0 && (
                <span className="text-xs opacity-70">({favorites.length})</span>
              )}
              {tab.id === 'recent' && recentPaths.length > 0 && (
                <span className="text-xs opacity-70">({recentPaths.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Search & Refresh */}
        <div className="flex gap-4 mb-3">
          <div className="relative flex-1">
            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder={t('pluginBrowser.searchPlaceholder')}
              aria-label={t('pluginBrowser.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted/50 border border-input rounded-lg py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            />
          </div>
          <button
            onClick={onScan}
            disabled={isLoading}
            aria-label={t('pluginBrowser.rescanAccessible')}
            className="px-4 py-2 bg-muted/50 border border-input rounded-lg text-muted-foreground hover:text-primary hover:border-primary/50 transition-all disabled:opacity-50"
            title={t('pluginBrowser.rescan')}
          >
            <MdRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Category Filter Chips */}
        {activeTab === 'all' && categories.length > 1 && !isLoading && (
          <div className="flex gap-1.5 mb-3 flex-wrap">
            <button
              onClick={() => setSelectedCategory(null)}
              aria-pressed={!selectedCategory}
              className={`px-2.5 py-1 text-xs rounded-full border transition-all ${
                !selectedCategory
                  ? 'bg-primary/10 text-primary border-primary/30 font-bold'
                  : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
              }`}
            >
              {t('pluginBrowser.allCountPrefix')}{plugins.length})
            </button>
            {categories.map(cat => (
              <button
                key={cat.name}
                onClick={() => setSelectedCategory(selectedCategory === cat.name ? null : cat.name)}
                aria-pressed={selectedCategory === cat.name}
                className={`px-2.5 py-1 text-xs rounded-full border transition-all ${
                  selectedCategory === cat.name
                    ? 'bg-primary/10 text-primary border-primary/30 font-bold'
                    : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
                }`}
              >
                {categoryLabel(cat.name)} ({cat.count})
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-bold">{t('pluginBrowser.scanning')}</p>
              <p className="text-xs opacity-70 text-center max-w-[80%] animate-pulse">
                {t('pluginBrowser.firstScan')}<br />
                {t('pluginBrowser.scanWait')}</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-40 text-destructive-text gap-2">
              <MdWarning className="w-8 h-8 opacity-50" />
              <p className="text-sm">{t('pluginBrowser.scanFailed')}</p>
              <details className="text-xs break-words"><summary>{t('common.rawDetail')}</summary><p>{error}</p></details>
            </div>
          ) : filteredPlugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              {searchQuery || selectedCategory ? <>
                <p>{t('pluginBrowser.noMatch')}</p>
                <button type="button" className="mt-3 rounded border border-border px-3 py-2 text-foreground" onClick={() => { setSearchQuery(''); setSelectedCategory(null); searchRef.current?.focus(); }}>{t('pluginBrowser.resetFilters')}</button>
                {activeTab !== 'all' && <button type="button" className="mt-2 underline text-primary" onClick={() => { setActiveTab('all'); setSearchQuery(''); setSelectedCategory(null); searchRef.current?.focus(); }}>{t('pluginBrowser.showAll')}</button>}
              </> : <>
                {activeTab === 'favorites' && <p>{t('pluginBrowser.noFavorites')}</p>}
                {activeTab === 'recent' && <p>{t('pluginBrowser.noRecent')}</p>}
                {activeTab === 'all' && <p>{t('pluginBrowser.notFound')}</p>}
                {activeTab !== 'all' && <button type="button" className="mt-3 underline text-primary" onClick={() => setActiveTab('all')}>{t('pluginBrowser.showAll')}</button>}
              </>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1">
              {filteredPlugins.map((plugin, idx) => {
                const isFavorite = favorites.includes(plugin.path);
                return (
                  <div
                    key={`${plugin.id}-${idx}`}
                    onClick={() => handlePluginSelect(plugin)}
                    onKeyDown={(e) => handlePluginKeyDown(e, plugin)}
                    className="group flex items-center justify-between p-3 rounded-lg border border-transparent hover:bg-muted/50 hover:border-primary/30 transition-all text-left cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={t('pluginBrowser.addNamed', { arg0: displayPluginName(plugin) })}
                  >
                    <div className="flex items-center gap-3">
                      {/* Favorite Star */}
                      <button
                        onClick={(e) => toggleFavorite(plugin.path, e)}
                        aria-label={isFavorite ? t('pluginBrowser.removeFavoriteNamed', { arg0: displayPluginName(plugin) }) : t('pluginBrowser.addFavoriteNamed', { arg0: displayPluginName(plugin) })}
                        aria-pressed={isFavorite}
                        className={`p-1 rounded transition-colors ${isFavorite
                          ? 'text-warning'
                          : 'text-muted-foreground hover:text-warning'
                          }`}
                        title={isFavorite ? t('pluginBrowser.removeFavorite') : t('pluginBrowser.addFavorite')}
                      >
                        {isFavorite ? <MdStar className="w-4 h-4" /> : <MdStarBorder className="w-4 h-4" />}
                      </button>
                      <div>
                        <h3 className="font-bold text-foreground group-hover:text-primary transition-colors">
                          {displayPluginName(plugin)}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {plugin.vendor || t('pluginBrowser.unknownVendor')}
                          <span className="opacity-30 mx-1">|</span>
                          <span className="text-primary/70">{getCategoryLabel(plugin.category, t)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="px-2 py-1 text-xs bg-primary/10 text-primary rounded border border-primary/20">
                        {t('pluginBrowser.add')}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>
    </div>
        </Modal>
  );
};
