import React, { useEffect, useState } from 'react';
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
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  // Load from localStorage
  useEffect(() => {
    const savedFavorites = localStorage.getItem(STORAGE_KEYS.favorites);
    const savedRecent = localStorage.getItem(STORAGE_KEYS.recent);
    if (savedFavorites) setFavorites(JSON.parse(savedFavorites));
    if (savedRecent) setRecentPaths(JSON.parse(savedRecent));
  }, []);

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

  useEffect(() => {
    if (isOpen && plugins.length === 0) {
      onScan();
    }
  }, [isOpen]);

  // Filter plugins based on search and tab
  const getFilteredPlugins = () => {
    let filtered = plugins.filter(p =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.vendor.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (activeTab === 'favorites') {
      filtered = filtered.filter(p => favorites.includes(p.path));
    } else if (activeTab === 'recent') {
      // Sort by recent order
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <Panel className="w-[600px] h-[500px] flex flex-col p-6 shadow-2xl border border-primary/20 relative overflow-hidden bg-card text-card-foreground">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-foreground tracking-tight">
            エフェクトを追加
          </h2>
          <button
            onClick={onClose}
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
        <div className="flex gap-4 mb-4">
          <div className="relative flex-1">
            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="名前またはベンダーで検索..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-muted/50 border border-input rounded-lg py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
            />
          </div>
          <button
            onClick={onScan}
            disabled={isLoading}
            className="px-4 py-2 bg-muted/50 border border-input rounded-lg text-muted-foreground hover:text-primary hover:border-primary/50 transition-all disabled:opacity-50"
            title="再スキャン"
          >
            <MdRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

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
              {activeTab === 'all' && <p>プラグインが見つかりませんでした</p>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {filteredPlugins.map((plugin, idx) => {
                const isFavorite = favorites.includes(plugin.path);
                return (
                  <div
                    key={`${plugin.id}-${idx}`}
                    onClick={() => handlePluginSelect(plugin)}
                    className="group flex items-center justify-between p-3 rounded-lg border border-transparent hover:bg-muted/50 hover:border-primary/30 transition-all text-left cursor-pointer"
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-center gap-3">
                      {/* Favorite Star */}
                      <button
                        onClick={(e) => toggleFavorite(plugin.path, e)}
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
                          {plugin.vendor} <span className="opacity-30 mx-1">|</span> {plugin.category}
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

        {/* Footer Gradient Fade - Removed as it might conflict with theming */}
      </Panel>
    </div>
  );
};
