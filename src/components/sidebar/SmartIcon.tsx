import React from 'react';
import { 
  LayoutGrid, Clock, Tag as TagIcon, Image as ImageIcon, Box,
  Filter, Search
} from 'lucide-react';

export function getSmartIcon(name: string) {
  switch (name) {
    case 'LayoutGrid': return <LayoutGrid size={16} className="text-blue-400" />;
    case 'Clock': return <Clock size={16} className="text-emerald-400" />;
    case 'Tag': return <TagIcon size={16} className="text-amber-400" />;
    case 'Image': return <ImageIcon size={16} className="text-purple-400" />;
    case 'Box': return <Box size={16} className="text-orange-400" />;
    case 'Search': return <Search size={16} className="text-cyan-400" />;
    default: return <Filter size={16} className="text-indigo-400" />;
  }
}
