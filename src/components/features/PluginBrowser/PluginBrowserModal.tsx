import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/button';
import type { MessageKey } from '@/i18n/messages';
import { useMessages } from '@/i18n/LocaleProvider';
import { Modal } from '../../ui/modal';
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { VstPlugin, type PluginScanRequest, type ScanFailure, type ScanFailureKind, type ScanStats } from '../../../api/audio';
import { Checkbox } from '@/components/ui/Checkbox';
import { fileLabel, pluginKey } from '@/lib/pluginIdentity';
import { Panel } from '../../ui/Panel/Panel';
import { MdStar, MdStarBorder, MdHistory, MdGridView, MdClose, MdSearch, MdRefresh, MdWarning } from 'react-icons/md';

interface PluginBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPluginSelect: (plugin: VstPlugin) => void;
  plugins: VstPlugin[];
  failures?: ScanFailure[];
  stats?: ScanStats | null;
  recoveredFromCorrupt?: boolean;
  saveError?: string | null;
  retryingPath?: string | null;
  isLoading: boolean;
  error?: string | null;
  notice?: string | null;
  protectionNotice?: string | null;
  onScan: (request?: PluginScanRequest) => void;
  onRetry?: (path: string) => void;
  /** VST 構成に入っているプラグインのパス。追加済みであることを一覧に示す。 */
  addedPaths?: string[];
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

function failureKey(kind: ScanFailureKind | string): MessageKey {
  switch (kind) {
    case 'crashed': return 'pluginBrowser.failure.crashed';
    case 'timed_out': return 'pluginBrowser.failure.timedOut';
    case 'load_failed': return 'pluginBrowser.failure.loadFailed';
    case 'no_factory': return 'pluginBrowser.failure.noFactory';
    case 'invalid_output': return 'pluginBrowser.failure.invalidOutput';
    case 'spawn_failed': return 'pluginBrowser.failure.spawnFailed';
    case 'legacy_blacklisted': return 'pluginBrowser.failure.legacyBlacklisted';
    default: return 'pluginBrowser.failure.unknown';
  }
}

function formatScannedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function readStoredPaths(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

function visibleIdentity(plugin: VstPlugin): string {
  return [plugin.name, fileLabel(plugin.path), plugin.vendor, plugin.version ?? ''].join('\0');
}

const MIN_CLASS_PREFIX = 8;
const MAX_CLASS_PREFIX = 32;

function classHex(classId: string | undefined): string | null {
  if (!classId) return null;
  const hex = classId.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex ? hex.slice(0, MAX_CLASS_PREFIX) : null;
}

/** 重複グループの中で、先頭から一意になる最短の桁。8桁より短くせず、32桁で打ち切る。 */
function uniqueClassPrefixes(hexes: Array<string | null>): Array<string | null> {
  return hexes.map((hex, index) => {
    if (!hex) return null;
    let length = Math.min(MIN_CLASS_PREFIX, hex.length);
    while (length < hex.length) {
      const prefix = hex.slice(0, length);
      const collided = hexes.some((other, otherIndex) =>
        otherIndex !== index && !!other && other.slice(0, length) === prefix);
      if (!collided) break;
      length += 1;
    }
    return hex.slice(0, length);
  });
}

function classPrefixByPlugin(plugins: VstPlugin[]): Map<VstPlugin, string> {
  const groups = new Map<string, number[]>();
  plugins.forEach((plugin, index) => {
    const identity = visibleIdentity(plugin);
    const bucket = groups.get(identity);
    if (bucket) bucket.push(index);
    else groups.set(identity, [index]);
  });
  const labels = new Map<VstPlugin, string>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const prefixes = uniqueClassPrefixes(indexes.map(index => classHex(plugins[index].classId)));
    indexes.forEach((index, offset) => {
      const prefix = prefixes[offset];
      if (prefix) labels.set(plugins[index], prefix);
    });
  }
  return labels;
}

/** path だけの旧キーは、そのパスの候補が1つなら新しいキーへ移す。複数や未スキャンは path のまま残す。 */
function migrateStoredKeys(stored: string[], plugins: VstPlugin[]): { keys: string[]; changed: boolean } {
  if (plugins.length === 0) return { keys: stored, changed: false };
  const keys: string[] = [];
  let changed = false;
  for (const key of stored) {
    if (key.includes('::')) {
      if (!keys.includes(key)) keys.push(key);
      continue;
    }
    const matches = plugins.filter(plugin => plugin.path === key);
    if (matches.length === 1) {
      const migrated = pluginKey(matches[0]);
      if (migrated !== key) changed = true;
      if (!keys.includes(migrated)) keys.push(migrated);
    } else if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  if (keys.length !== stored.length) changed = true;
  return { keys, changed };
}

/** 新しいキーは完全一致。path だけの旧キーは、候補が複数のときだけそのパスのクラスをすべて出す。 */
function storedKeyMatches(plugin: VstPlugin, stored: string, plugins: VstPlugin[]): boolean {
  if (stored === pluginKey(plugin)) return true;
  if (stored.includes('::') || plugin.path !== stored) return false;
  return plugins.filter(candidate => candidate.path === plugin.path).length !== 1;
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
  failures = [],
  stats = null,
  recoveredFromCorrupt = false,
  saveError = null,
  retryingPath = null,
  isLoading,
  error,
  notice,
  protectionNotice,
  addedPaths = [],
  onScan,
  onRetry,
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
  const [includeFailed, setIncludeFailed] = useState(false);

  // 候補が見えた時点で、path だけの旧キーを1件なら新しいキーへ移す。
  // お気に入りと履歴の両方が書けたときだけ移行完了にする。片方だけ残さない。
  useEffect(() => {
    const favoriteStored = readStoredPaths(STORAGE_KEYS.favorites);
    const recentStored = readStoredPaths(STORAGE_KEYS.recent);
    const nextFavorites = migrateStoredKeys(favoriteStored, plugins);
    const nextRecent = migrateStoredKeys(recentStored, plugins);
    if (!nextFavorites.changed && !nextRecent.changed) {
      setFavorites(nextFavorites.keys);
      setRecentPaths(nextRecent.keys);
      return;
    }
    const previousFavorites = localStorage.getItem(STORAGE_KEYS.favorites);
    const previousRecent = localStorage.getItem(STORAGE_KEYS.recent);
    const restoreStored = (key: string, previous: string | null) => {
      try {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      } catch {
        // 戻し書きも失敗したときは旧キーを残し、次の表示で再試行する。
      }
    };
    try {
      if (nextFavorites.changed) localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(nextFavorites.keys));
      if (nextRecent.changed) localStorage.setItem(STORAGE_KEYS.recent, JSON.stringify(nextRecent.keys));
    } catch {
      restoreStored(STORAGE_KEYS.favorites, previousFavorites);
      restoreStored(STORAGE_KEYS.recent, previousRecent);
      setFavorites(favoriteStored);
      setRecentPaths(recentStored);
      return;
    }
    setFavorites(nextFavorites.keys);
    setRecentPaths(nextRecent.keys);
  }, [plugins]);

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

  const toggleFavorite = (plugin: VstPlugin, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = pluginKey(plugin);
    // 複数候補の path キーは、星を押したクラスへだけ付け替える。
    const withoutThis = favorites.filter(stored => stored !== plugin.path && stored !== key);
    saveFavorites(favorites.includes(key) ? withoutThis : [...withoutThis, key]);
  };

  const handlePluginSelect = (plugin: VstPlugin) => {
    const key = pluginKey(plugin);
    const newRecent = [key, ...recentPaths.filter(stored => stored !== key && stored !== plugin.path)].slice(0, MAX_RECENT);
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
      filtered = filtered.filter(plugin => favorites.some(stored => storedKeyMatches(plugin, stored, plugins)));
    } else if (activeTab === 'recent') {
      const seen = new Set<string>();
      const recentPlugins: VstPlugin[] = [];
      for (const stored of recentPaths) {
        for (const plugin of plugins) {
          if (!storedKeyMatches(plugin, stored, plugins)) continue;
          const key = pluginKey(plugin);
          if (seen.has(key)) continue;
          seen.add(key);
          recentPlugins.push(plugin);
        }
      }
      filtered = recentPlugins.filter(matchesSearch);
    }

    return filtered;
  };

  const filteredPlugins = getFilteredPlugins();
  const classPrefixes = useMemo(() => classPrefixByPlugin(plugins), [plugins]);

  if (!isOpen) return null;

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: t('pluginBrowser.tab.all'), icon: <MdGridView className="w-3 h-3" /> },
    { id: 'recent', label: t('pluginBrowser.tab.recent'), icon: <MdHistory className="w-3 h-3" /> },
    { id: 'favorites', label: t('pluginBrowser.tab.favorites'), icon: <MdStar className="w-3 h-3" /> },
  ];

  return (
    <Modal title={t('pluginBrowser.title')} onClose={onClose}>
        <div className="modal-overlay-base z-[100]"><Tabs value={activeTab} onValueChange={value => setActiveTab(value as TabType)} className="contents">
      <Panel className="modal-surface-base w-[calc(100vw-2rem)] max-w-[700px] h-[calc(100vh-3rem)] max-h-[550px] flex flex-col p-4 sm:p-6 relative overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-ui-heading font-bold text-foreground tracking-tight">
            {t('pluginBrowser.title')}</h2>
          <Button variant="ghost" size="icon"
            onClick={onClose}
            aria-label={t('pluginBrowser.close')}

          >
            <MdClose className="w-5 h-5" />
          </Button>
        </div>

        {/* Tabs */}
        <TabsList aria-label={t('pluginBrowser.filter')} className="flex gap-1 mb-4 p-1 bg-muted rounded-card">
          {tabs.map(tab => (
            <TabsTrigger value={tab.id} key={tab.id} className="flex-1 gap-1.5">
              {tab.icon}
              {tab.label}
              {tab.id === 'favorites' && favorites.length > 0 && (
                <span className="text-ui-support">({favorites.length})</span>
              )}
              {tab.id === 'recent' && recentPaths.length > 0 && (
                <span className="text-ui-support">({recentPaths.length})</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={activeTab} className="m-0 flex min-h-0 flex-1 flex-col">{/* Search & Refresh */}
        <div className="flex gap-4 mb-3">
          <div className="relative flex-1">
            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Field label={null}><Input
              ref={searchRef}
              type="text"
              placeholder={t('pluginBrowser.searchPlaceholder')}
              aria-label={t('pluginBrowser.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4"
            /></Field>
          </div>
          <Button variant="outline"
            onClick={() => onScan()}
            disabled={isLoading || Boolean(retryingPath)}
            aria-label={t('pluginBrowser.rescanAccessible')}

            title={t('pluginBrowser.rescan')}
          >
            <MdRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal"
            disabled={isLoading || Boolean(retryingPath)}
            onClick={() => onScan({ mode: 'full', retryFailed: includeFailed })}
          >
            {t('pluginBrowser.fullScan')}
          </Button>
          <label className="flex items-center gap-2 text-ui-support" htmlFor="plugin-scan-include-failed">
            <Checkbox id="plugin-scan-include-failed" checked={includeFailed} disabled={isLoading || Boolean(retryingPath)} onChange={event => setIncludeFailed(event.target.checked)} />
            {t('pluginBrowser.includeFailed')}
          </label>
          <p className="w-full text-ui-support text-muted-foreground">{t('pluginBrowser.includeFailedHelp')}</p>
        </div>

        {/* Category Filter Chips */}
        {activeTab === 'all' && categories.length > 1 && !isLoading && (
          <div className="flex gap-1.5 mb-3 flex-wrap">
            <button
              onClick={() => setSelectedCategory(null)}
              aria-pressed={!selectedCategory}
              className={`px-2.5 py-1 text-ui-support rounded-full border transition-colors ${
                !selectedCategory
                  ? 'bg-selection/15 text-selection border-selection/40 font-bold'
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
                className={`px-2.5 py-1 text-ui-support rounded-full border transition-colors ${
                  selectedCategory === cat.name
                    ? 'bg-selection/15 text-selection border-selection/40 font-bold'
                    : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
                }`}
              >
                {categoryLabel(cat.name)} ({cat.count})
              </button>
            ))}
          </div>
        )}

        {protectionNotice && <p role="status" className="mb-3 rounded-control border border-warning/30 bg-warning/10 p-2 text-ui-support">{protectionNotice}</p>}
        {notice && notice !== protectionNotice && <p role="status" className="mb-3 text-ui-support text-warning">{notice}</p>}

        {/* List */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-3">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-ui-support font-bold">{t('pluginBrowser.scanning')}</p>
              <p className="text-ui-support text-center max-w-[80%]">
                {t('pluginBrowser.firstScan')}<br />
                {t('pluginBrowser.scanWait')}</p>
            </div>
          ) : error ? (
            <div className="flex min-w-0 flex-col items-center justify-center min-h-40 py-6 text-center wrap-anywhere text-destructive-text gap-2">
              <MdWarning className="w-8 h-8 opacity-50" />
              <p className="text-ui-support">{t('pluginBrowser.scanFailed')}</p>
              {failures.length > 0 && <p>{t('pluginBrowser.failedCount', { count: failures.length })}</p>}
              <details className="text-ui-support break-words"><summary>{t('common.rawDetail')}</summary><p>{error}</p></details>
              <Button variant="outline" size="sm" disabled={Boolean(retryingPath)} onClick={() => onScan({ mode: 'full', retryFailed: true })}>{t('pluginBrowser.forceRescan')}</Button>
            </div>
          ) : filteredPlugins.length === 0 ? (
            <div className="flex min-w-0 flex-col items-center justify-center min-h-40 py-6 text-center wrap-anywhere text-muted-foreground">
              {searchQuery || selectedCategory ? <>
                <h3 className="text-ui-control font-semibold">{searchQuery ? t('pluginBrowser.searchNoMatch', { query: searchQuery }) : t('pluginBrowser.noMatch')}</h3>
                <Button variant="outline" type="button" className="mt-3" onClick={() => { setSearchQuery(''); setSelectedCategory(null); searchRef.current?.focus(); }}>{t('pluginBrowser.resetFilters')}</Button>
                {activeTab !== 'all' && <button type="button" className="mt-2 underline text-primary" onClick={() => { setActiveTab('all'); setSearchQuery(''); setSelectedCategory(null); searchRef.current?.focus(); }}>{t('pluginBrowser.showAll')}</button>}
              </> : <>
                {activeTab === 'favorites' && <h3 className="text-ui-control font-semibold">{t('pluginBrowser.noFavorites')}</h3>}
                {activeTab === 'recent' && <h3 className="text-ui-control font-semibold">{t('pluginBrowser.noRecent')}</h3>}
                {activeTab === 'all' && <>
                  <h3 className="text-ui-control font-semibold">{t(failures.length > 0 ? 'pluginBrowser.emptyFailed' : 'pluginBrowser.notFound')}</h3>
                  {failures.length > 0 ? <>
                    <p>{t('pluginBrowser.failedCount', { count: failures.length })}</p>
                    <Button variant="outline" size="sm" className="mt-3" disabled={Boolean(retryingPath)} onClick={() => onScan({ mode: 'full', retryFailed: true })}>{t('pluginBrowser.forceRescan')}</Button>
                  </> : <>
                    <p className="text-center">{t('pluginBrowser.emptyScanHint')}</p>
                  </>}
                </>}
                {activeTab !== 'all' && <button type="button" className="mt-3 underline text-primary" onClick={() => setActiveTab('all')}>{t('pluginBrowser.showAll')}</button>}
              </>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1">
              {filteredPlugins.map((plugin, idx) => {
                const key = pluginKey(plugin);
                const isFavorite = favorites.includes(key);
                const shortId = classPrefixes.get(plugin) ?? null;
                const accessibleName = shortId ? `${displayPluginName(plugin)} ${shortId}` : displayPluginName(plugin);
                return (
                  <div
                    key={`${key}-${idx}`}
                    onClick={() => handlePluginSelect(plugin)}
                    onKeyDown={(e) => handlePluginKeyDown(e, plugin)}
                    className="group flex items-center justify-between p-3 rounded-card border border-transparent hover:bg-muted/50 hover:border-primary/30 transition-colors text-left cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={t('pluginBrowser.addNamed', { arg0: accessibleName })}
                  >
                    <div className="flex items-center gap-3">
                      {/* Favorite Star */}
                      <button
                        onClick={(e) => toggleFavorite(plugin, e)}
                        aria-label={isFavorite ? t('pluginBrowser.removeFavoriteNamed', { arg0: accessibleName }) : t('pluginBrowser.addFavoriteNamed', { arg0: accessibleName })}
                        aria-pressed={isFavorite}
                        className={`p-1 rounded-control transition-colors ${isFavorite
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
                          {shortId && <span className="ml-2 font-mono text-ui-support text-muted-foreground">{shortId}</span>}
                          <span className="ml-2 font-normal text-ui-support text-muted-foreground">{fileLabel(plugin.path)}</span>
                        </h3>
                        {plugin.nameSource === 'file' && (
                          <p className="text-ui-support text-muted-foreground">{t('pluginBrowser.nameUnavailable')}</p>
                        )}
                        <p className="text-ui-support text-muted-foreground">
                          <span>{plugin.vendor || t('pluginBrowser.unknownMeta')}</span>
                          <span className="opacity-30 mx-1">|</span>
                          <span>{plugin.version || t('pluginBrowser.unknownMeta')}</span>
                          <span className="mx-1">|</span>
                          <span className="text-primary">{getCategoryLabel(plugin.category, t)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {addedPaths.includes(key) && <span className="px-2 py-1 text-ui-support text-muted-foreground rounded-control border border-border">{t('pluginBrowser.added')}</span>}
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 text-ui-support bg-primary/10 text-primary rounded-control border border-primary/20">
                        {t('pluginBrowser.add')}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!isLoading && (stats || recoveredFromCorrupt || saveError || failures.length > 0) && <section className="space-y-2 border-t border-border pt-3" aria-label={t('pluginBrowser.failuresTitle')}>
            {stats && <p role="status">{t('pluginBrowser.scanStats', { reused: stats.reused, scanned: stats.scanned, removed: stats.removed })}</p>}
            {recoveredFromCorrupt && <p role="status">{t('pluginBrowser.catalogRecovered')}</p>}
            {saveError && <p role="alert">{t('pluginBrowser.catalogSaveFailed')}</p>}
            {failures.length > 0 && <>
              <h3 className="text-ui-heading font-semibold">{t('pluginBrowser.failuresTitle')}</h3>
              <p className="text-ui-support text-muted-foreground">{t('pluginBrowser.retryAuth')}</p>
              <ul className="space-y-2">
                {failures.map(failure => (
                  <li key={failure.path} className="space-y-1 rounded-control border border-border p-2">
                    <p className="font-medium" title={failure.path}>{failure.name}</p>
                    <p className="text-ui-support">{t(failureKey(failure.kind))}</p>
                    <p className="text-ui-support text-muted-foreground">{t('pluginBrowser.failure.attempted', { time: formatScannedAt(failure.scannedAt), count: failure.attempts })}</p>
                    {failure.detail && <details className="text-ui-support break-words"><summary>{t('common.rawDetail')}</summary><p>{failure.detail}</p></details>}
                    <Button variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal"
                      aria-label={t('pluginBrowser.retryNamed', { name: failure.name })}
                      aria-busy={retryingPath === failure.path}
                      disabled={!onRetry || isLoading || Boolean(retryingPath)}
                      onClick={() => onRetry?.(failure.path)}
                    >
                      {retryingPath === failure.path ? t('pluginBrowser.retrying') : t('pluginBrowser.retryOne')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>}
          </section>}
        </div>
</TabsContent>      </Panel>
    </Tabs></div>
        </Modal>
  );
};
