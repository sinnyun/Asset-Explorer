import React from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

export function SearchBar({ placeholder, value, onChange }: SearchBarProps) {
  return (
    <div className="p-3 border-b border-neutral-800/50 shrink-0">
      <div className="relative">
        <Search className="absolute left-2.5 top-2 text-neutral-500" size={14} />
        <input 
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-[#141414] border border-neutral-800 rounded-md py-1.5 pl-8 pr-7 text-xs text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
        />
        {value && (
          <button 
            onClick={() => onChange('')}
            className="absolute right-2 top-2 text-neutral-500 hover:text-neutral-300"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
