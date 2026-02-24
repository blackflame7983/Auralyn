import React, { useEffect, useState, useMemo } from 'react';
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

// Map VST3 category strings to user-friendly Japanese labels
const CATEGORY_LABELS: Record<string, string> = {
  'Fx': 'エフェクト全般',
  'Fx|Dynamics': 'ダイナミクス (コンプ等)',
  'Fx|EQ': 'イコライザー',
  'Fx|Reverb': 'リバーブ',
  'Fx|Delay': 'ディレイ',
  'Fx|Distortion': 'ディストーション',
  'Fx|Filter': 'フィルター',
  'Fx|Modulation': 'モジュレーション',
  'Fx|Mastering': 'マスタリング',
  'Fx|Spatial': 'スペーシャル',
  'Fx|Restoration': '修復・ノイズ除去',
  'Fx|Analyzer': 'アナライザー',
  'Fx|Tools': 'ツール',
  'Fx|Network': 'ネットワーク',
  'Fx|Generator': 'ジェネレーター',
  'Instrument': 'インストゥルメント',
  'Instrument|Synth': 'シンセサイザー',
  'Instrument|Sampler': 'サンプラー',
  'Instrument|Drum': 'ドラム',
};

function getCategoryLabel(category: string | undefined): string {
  if (!category) return '未分類';
  // Try exact match first
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  // Try prefix match
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    if (category.startsWith(key)) return label;
  }
  // Fallback
  if (category.startsWith('Fx')) return 'エフェクト (その他)';
  if (category.startsWith('Instrument')) return 'インストゥルメント';
  return category || '未分類';
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
  plugins,
  isLoading,
  error,
  onScan
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  // Load from localStorage
  useEffect(() => {
    const savedFavorites = localStorage.getItem(STORAGE_KEYS.favorites);
    const savedRecent = localStorage.getItem(STORAGE_KEYS.recent);
    if (savedFavorites) setFavorites(JSON.parse(savedFavorites));
    if (savedRecent) setRecentPaths(JSON.parse(savedRecent));
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
    let filtered = plugins.filter(p =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.vendor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase())
    );

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
      filtered = recentPlugins.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.vendor.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return filtered;
  };

  const filteredPlugins = getFilteredPlugins();

  if (!isOpen) return null;

  const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: 'すべて', icon: <MdGridView className="w-3 h-3" /> },
    { id: 'recent', label: '最近', icon: <MdHistory className="w-3 h-3" /> },
    { id: 'favorites', label: 'お気に入り', icon: <MdStar className="w-3 h-3" /> },
  ];

  return (
    <div className="modal-overlay-base z-[100]">
      <Panel className="w-[calc(100vw-2rem)] max-w-[700px] h-[calc(100vh-3rem)] max-h-[550px] flex flex-col p-4 sm:p-6 shadow-2xl border border-primary/20 relative overflow-hidden bg-card text-card-foreground">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-foreground tracking-tight">
            エフェクトを追加
          </h2>
          <button
            onClick={onClose}
            aria-label="プラグイン追加画面を閉じる"
            className="p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <MdClose className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 p-1 bg-muted rounded-lg">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${activeTab === tab.id
                ? 'bg-background text-primary shadow-sm font-bold'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'favorites' && favorites.length > 0 && (
                <span className="text-[10px] opacity-70">({favorites.length})</span>
              )}
              {tab.id === 'recent' && recentPaths.length > 0 && (
                <span className="text-[10px] opacity-70">({recentPaths.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Search & Refresh */}
        <div className="flex gap-4 mb-3">
          <div className="relative flex-1">
            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="名前・ベンダー・カテゴリで検索..."
              aria-label="プラグイン検索"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted/50 border border-input rounded-lg py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            />
          </div>
          <button
            onClick={onScan}
            disabled={isLoading}
            aria-label="プラグインを再スキャン"
            className="px-4 py-2 bg-muted/50 border border-input rounded-lg text-muted-foreground hover:text-primary hover:border-primary/50 transition-all disabled:opacity-50"
            title="再スキャン"
          >
            <MdRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Category Filter Chips */}
        {activeTab === 'all' && categories.length > 1 && !isLoading && (
          <div className="flex gap-1.5 mb-3 flex-wrap">
            <button
              onClick={() => setSelectedCategory(null)}
              className={`px-2.5 py-1 text-[11px] rounded-full border transition-all ${
                !selectedCategory
                  ? 'bg-primary/10 text-primary border-primary/30 font-bold'
                  : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
              }`}
            >
              すべて ({plugins.length})
            </button>
            {categories.map(cat => (
              <button
                key={cat.name}
                onClick={() => setSelectedCategory(selectedCategory === cat.name ? null : cat.name)}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-all ${
                  selectedCategory === cat.name
                    ? 'bg-primary/10 text-primary border-primary/30 font-bold'
                    : 'bg-muted/50 text-muted-foreground border-border hover:border-primary/30 hover:text-foreground'
                }`}
              >
                {cat.name} ({cat.count})
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-3">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-bold">プラグインをスキャン中...</p>
              <p className="text-xs opacity-70 text-center max-w-[80%] animate-pulse">
                初回は数分かかる場合があります。<br />
                画面が止まって見えても、そのままお待ちください。
              </p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-40 text-destructive gap-2">
              <MdWarning className="w-8 h-8 opacity-50" />
              <p className="text-sm">{error}</p>
            </div>
          ) : filteredPlugins.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground opacity-50">
              {activeTab === 'favorites' && <p>お気に入りがありません</p>}
              {activeTab === 'recent' && <p>最近使用したプラグインがありません</p>}
              {activeTab === 'all' && selectedCategory && <p>「{selectedCategory}」カテゴリのプラグインが見つかりませんでした</p>}
              {activeTab === 'all' && !selectedCategory && <p>プラグインが見つかりませんでした</p>}
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
                    aria-label={`${plugin.name} を追加`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Favorite Star */}
                      <button
                        onClick={(e) => toggleFavorite(plugin.path, e)}
                        aria-label={isFavorite ? `${plugin.name} をお気に入りから削除` : `${plugin.name} をお気に入りに追加`}
                        aria-pressed={isFavorite}
                        className={`p-1 rounded transition-colors ${isFavorite
                          ? 'text-yellow-400'
                          : 'text-muted-foreground hover:text-yellow-400'
                          }`}
                        title={isFavorite ? 'お気に入りから削除' : 'お気に入りに追加'}
                      >
                        {isFavorite ? <MdStar className="w-4 h-4" /> : <MdStarBorder className="w-4 h-4" />}
                      </button>
                      <div>
                        <h3 className="font-bold text-foreground group-hover:text-primary transition-colors">
                          {plugin.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {plugin.vendor || '不明なベンダー'}
                          <span className="opacity-30 mx-1">|</span>
                          <span className="text-primary/70">{getCategoryLabel(plugin.category)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="px-2 py-1 text-[10px] bg-primary/10 text-primary rounded border border-primary/20">
                        追加
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
};
