import React, { useState } from 'react';
import { Smile, X } from 'lucide-react';
import type { SubtitleLine, SubtitleWordTiming } from '../types';

/**
 * Pins an emoji to a single word, the way Opus Clip does.
 *
 * It only appears for lines that carry real per-word timings, because an emoji
 * is tied to the beat its word is spoken on. Lines from YouTube captions are
 * timed per phrase, so there is no beat to pin to - the component says so
 * rather than pinning the emoji to a guess.
 */

interface WordEmojiPickerProps {
  line: SubtitleLine;
  onChange: (words: SubtitleWordTiming[]) => void;
}

/**
 * A short palette rather than a full emoji keyboard.
 *
 * These are the ones short-form captions actually use; a complete picker makes
 * the choice slower without making the clip better.
 */
const PALETTE = [
  '🔥', '😂', '😮', '💰', '👉', '❤️', '💯', '🤯',
  '👀', '✅', '❌', '🙌', '⚡', '🧠', '🚀', '😱',
];

export const WordEmojiPicker: React.FC<WordEmojiPickerProps> = ({ line, onChange }) => {
  const [openWord, setOpenWord] = useState<number | null>(null);

  const words = line.words ?? [];

  if (words.length === 0) {
    return (
      <p className="text-[11px] text-slate-500 flex items-center space-x-1.5">
        <Smile className="w-3 h-3 shrink-0" />
        <span>
          Esta línea no tiene tiempos por palabra. Transcribe con Whisper para poder
          poner emojis sobre una palabra concreta.
        </span>
      </p>
    );
  }

  const setEmoji = (index: number, emoji: string | null) => {
    onChange(
      words.map((word, i) => {
        if (i !== index) return word;
        // Dropping the key entirely, rather than leaving undefined, keeps the
        // exported JSON clean and the "has any emoji" checks simple.
        const { emoji: _previous, ...rest } = word;
        return emoji ? { ...rest, emoji } : rest;
      })
    );
    setOpenWord(null);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {words.map((word, index) => (
          <button
            key={`${index}-${word.text}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpenWord(openWord === index ? null : index);
            }}
            title={word.emoji ? 'Cambiar o quitar el emoji' : 'Poner un emoji en esta palabra'}
            className={`px-1.5 py-0.5 rounded text-[11px] border transition-colors ${
              openWord === index
                ? 'border-amber-400 bg-amber-400/10 text-amber-200'
                : word.emoji
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500'
            }`}
          >
            {word.text}
            {word.emoji ? <span className="ml-1">{word.emoji}</span> : null}
          </button>
        ))}
      </div>

      {openWord !== null && (
        <div
          onClick={(event) => event.stopPropagation()}
          className="rounded-lg border border-slate-700 bg-slate-950 p-2 space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">
              Emoji sobre <span className="text-white font-medium">{words[openWord].text}</span>
            </span>
            <button
              type="button"
              onClick={() => setOpenWord(null)}
              className="text-slate-500 hover:text-white"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {PALETTE.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setEmoji(openWord, emoji)}
                className={`w-7 h-7 rounded text-base leading-none transition-colors ${
                  words[openWord].emoji === emoji
                    ? 'bg-emerald-500/20 ring-1 ring-emerald-400'
                    : 'hover:bg-slate-800'
                }`}
              >
                {emoji}
              </button>
            ))}
          </div>

          {words[openWord].emoji && (
            <button
              type="button"
              onClick={() => setEmoji(openWord, null)}
              className="text-[11px] text-slate-400 hover:text-rose-300"
            >
              Quitar el emoji de esta palabra
            </button>
          )}
        </div>
      )}
    </div>
  );
};
