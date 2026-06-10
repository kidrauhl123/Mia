/**
 * STEM Flashcard Template
 * 
 * Features:
 * - Client-side KaTeX rendering (token-efficient: raw LaTeX input)
 * - Three-layer cognitive framework (L1/L2/L3)
 * - Starred cards functionality
 * - Topic and layer filtering
 * - Shuffle mode
 * 
 * Usage: 
 * 1. Replace the `flashcards` array with generated content
 * 2. Update TITLE constant
 * 3. Update topicNames mapping
 * 4. Each card needs: id, layer, topic, starred, q (question), a (raw LaTeX or plain text)
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';

// ============================================================
// CONFIGURATION - UPDATE THESE
// ============================================================
const TITLE = 'STEM Atomic Flashcards';

const topicNames = {
  'ExampleTopic': 'Example Topic',
  // Add more: 'TopicKey': 'Display Name'
};

// ============================================================
// REPLACE THIS ARRAY WITH GENERATED FLASHCARDS
// ============================================================
const flashcards = [
  // Example card structures:
  // { id: 1, layer: 'L1', topic: 'ExampleTopic', starred: false, q: 'What is the quadratic formula?', a: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
  // { id: 2, layer: 'L2', topic: 'ExampleTopic', starred: false, q: 'Why does gradient descent work?', a: 'It iteratively moves toward the minimum by following the negative gradient direction.' },
];
// ============================================================

// KaTeX CSS from CDN
const katexCSS = `@import url('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css');`;

/**
 * MathRenderer Component
 * 
 * Renders content with LaTeX math using client-side KaTeX.
 * Detects math patterns and renders them, passing through plain text.
 * 
 * Supports:
 * - Standalone LaTeX (entire string is a formula)
 * - Inline math with $ delimiters
 * - Mixed text and math
 */
const MathRenderer = ({ content }) => {
  const containerRef = useRef(null);
  const [katexLoaded, setKatexLoaded] = useState(false);

  // Load KaTeX library dynamically
  useEffect(() => {
    if (window.katex) {
      setKatexLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
    script.onload = () => setKatexLoaded(true);
    script.onerror = () => console.error('Failed to load KaTeX');
    document.head.appendChild(script);
  }, []);

  // Render math when KaTeX is loaded
  useEffect(() => {
    if (!katexLoaded || !containerRef.current || !content) return;

    const container = containerRef.current;
    
    // Check if content looks like pure LaTeX (contains LaTeX commands but no $ delimiters)
    const isPureLaTeX = /\\[a-zA-Z]+/.test(content) && !content.includes('$');
    
    if (isPureLaTeX) {
      // Render entire content as display math
      try {
        window.katex.render(content, container, {
          throwOnError: false,
          displayMode: true
        });
      } catch (e) {
        container.textContent = content;
      }
      return;
    }

    // Handle mixed content with $ delimiters for inline math
    // Split on $...$ patterns
    const parts = content.split(/(\$[^$]+\$)/g);
    container.innerHTML = '';

    parts.forEach(part => {
      if (part.startsWith('$') && part.endsWith('$')) {
        // Inline math
        const latex = part.slice(1, -1);
        const span = document.createElement('span');
        try {
          window.katex.render(latex, span, {
            throwOnError: false,
            displayMode: false
          });
        } catch (e) {
          span.textContent = latex;
        }
        container.appendChild(span);
      } else if (part) {
        // Plain text
        const textNode = document.createTextNode(part);
        container.appendChild(textNode);
      }
    });
  }, [content, katexLoaded]);

  // Show loading state or plain content while KaTeX loads
  if (!katexLoaded) {
    return <div className="text-gray-700">{content}</div>;
  }

  return <div ref={containerRef} className="text-gray-700 overflow-x-auto" />;
};

const AtomicFlashcards = () => {
  const [currentLayer, setCurrentLayer] = useState('all');
  const [currentTopic, setCurrentTopic] = useState('all');
  const [showAnswer, setShowAnswer] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [shuffled, setShuffled] = useState(false);
  const [starredIds, setStarredIds] = useState([]);
  const [showStarred, setShowStarred] = useState(false);

  const layers = ['all', 'L1', 'L2', 'L3'];
  const topics = ['all', ...new Set(flashcards.map(c => c.topic))];
  
  const layerNames = { 'L1': 'Recall', 'L2': 'Understanding', 'L3': 'Boundaries' };
  const layerColors = { 'L1': 'border-blue-400', 'L2': 'border-green-400', 'L3': 'border-red-400' };

  // Load starred cards from pre-baked data on mount
  // Note: localStorage removed for Claude artifact compatibility
  useEffect(() => {
    const preBaked = flashcards.filter(c => c.starred).map(c => c.id);
    setStarredIds(preBaked);
  }, []);

  // Toggle star (session-only, no localStorage)
  const toggleStar = (id, e) => {
    e.stopPropagation();
    setStarredIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const filteredCards = useMemo(() => {
    let cards = flashcards;
    
    if (showStarred) {
      cards = cards.filter(c => starredIds.includes(c.id));
    }
    
    cards = cards.filter(c => 
      (currentLayer === 'all' || c.layer === currentLayer) &&
      (currentTopic === 'all' || c.topic === currentTopic)
    );
    
    if (shuffled) {
      cards = [...cards].sort(() => Math.random() - 0.5);
    }
    return cards;
  }, [currentLayer, currentTopic, shuffled, showStarred, starredIds]);

  const currentCard = filteredCards[currentIndex] || null;

  const nextCard = () => {
    setShowAnswer(false);
    setCurrentIndex((currentIndex + 1) % filteredCards.length);
  };

  const prevCard = () => {
    setShowAnswer(false);
    setCurrentIndex((currentIndex - 1 + filteredCards.length) % filteredCards.length);
  };

  const resetDeck = () => {
    setCurrentIndex(0);
    setShowAnswer(false);
  };

  const topicCounts = {};
  topics.filter(t => t !== 'all').forEach(t => {
    topicCounts[t] = flashcards.filter(c => c.topic === t).length;
  });

  return (
    <>
      <style>{katexCSS}</style>
      <div className="min-h-screen bg-gray-50 p-4">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl font-bold text-center mb-2 text-gray-800">{TITLE}</h1>
          <p className="text-center text-gray-600 mb-4 text-sm">{flashcards.length} cards across 3 layers covering {topics.length - 1} topics</p>
          
          {/* Controls */}
          <div className="bg-white rounded-lg shadow p-4 mb-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Layer</label>
                <select 
                  value={currentLayer} 
                  onChange={(e) => { setCurrentLayer(e.target.value); resetDeck(); }}
                  className="w-full p-2 border rounded text-sm"
                >
                  {layers.map(l => (
                    <option key={l} value={l}>{l === 'all' ? 'All Layers' : `${l}: ${layerNames[l]}`}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Topic</label>
                <select 
                  value={currentTopic} 
                  onChange={(e) => { setCurrentTopic(e.target.value); resetDeck(); }}
                  className="w-full p-2 border rounded text-sm"
                >
                  <option value="all">All Topics</option>
                  {topics.filter(t => t !== 'all').map(t => (
                    <option key={t} value={t}>{topicNames[t] || t} ({topicCounts[t]})</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button 
                  onClick={() => { setShowStarred(!showStarred); resetDeck(); }}
                  className={`w-full p-2 rounded text-sm font-medium ${showStarred ? 'bg-yellow-400 text-yellow-900' : 'bg-gray-200 text-gray-700'}`}
                >
                  {showStarred ? `★ Starred (${starredIds.length})` : '☆ Show Starred'}
                </button>
              </div>
              <div className="flex items-end">
                <button 
                  onClick={() => { setShuffled(!shuffled); resetDeck(); }}
                  className={`w-full p-2 rounded text-sm font-medium ${shuffled ? 'bg-purple-500 text-white' : 'bg-gray-200 text-gray-700'}`}
                >
                  {shuffled ? '🔀 Shuffled' : '📋 Ordered'}
                </button>
              </div>
              <div className="flex items-end">
                <button 
                  onClick={resetDeck}
                  className="w-full p-2 bg-gray-200 rounded text-sm font-medium text-gray-700 hover:bg-gray-300"
                >
                  🔄 Reset
                </button>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="flex justify-between items-center mb-3 px-2">
            <span className="text-sm text-gray-600">
              Card {filteredCards.length > 0 ? currentIndex + 1 : 0} of {filteredCards.length}
            </span>
            <div className="flex gap-2">
              <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded">L1: {flashcards.filter(c => c.layer === 'L1').length}</span>
              <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">L2: {flashcards.filter(c => c.layer === 'L2').length}</span>
              <span className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded">L3: {flashcards.filter(c => c.layer === 'L3').length}</span>
            </div>
          </div>

          {/* Flashcard */}
          {currentCard ? (
            <div 
              className={`rounded-xl shadow-lg p-6 min-h-64 cursor-pointer border-l-4 ${layerColors[currentCard.layer]} bg-white`}
              onClick={() => setShowAnswer(!showAnswer)}
            >
              <div className="flex justify-between items-start mb-4">
                <span className={`text-xs font-bold px-2 py-1 rounded ${
                  currentCard.layer === 'L1' ? 'bg-blue-200 text-blue-800' :
                  currentCard.layer === 'L2' ? 'bg-green-200 text-green-800' :
                  'bg-red-200 text-red-800'
                }`}>
                  {currentCard.layer}: {layerNames[currentCard.layer]}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-1 bg-gray-200 text-gray-700 rounded">
                    {topicNames[currentCard.topic] || currentCard.topic}
                  </span>
                  <button
                    onClick={(e) => toggleStar(currentCard.id, e)}
                    className={`text-xl transition-colors ${starredIds.includes(currentCard.id) ? 'text-yellow-400' : 'text-gray-300 hover:text-yellow-300'}`}
                  >
                    {starredIds.includes(currentCard.id) ? '★' : '☆'}
                  </button>
                </div>
              </div>
              
              <div className="mt-4">
                <p className="text-lg font-semibold text-gray-800 mb-4">{currentCard.q}</p>
                
                {showAnswer ? (
                  <div className="mt-4 p-4 bg-gray-50 rounded-lg border">
                    <MathRenderer content={currentCard.a} />
                  </div>
                ) : (
                  <p className="text-gray-400 text-sm italic mt-8">Click to reveal answer...</p>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-lg p-8 text-center">
              <p className="text-gray-500">No cards match current filters</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-4">
            <button 
              onClick={prevCard}
              disabled={filteredCards.length === 0}
              className="px-6 py-2 bg-gray-200 rounded-lg font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              ← Previous
            </button>
            <button 
              onClick={() => setShowAnswer(!showAnswer)}
              className="px-6 py-2 bg-indigo-500 text-white rounded-lg font-medium hover:bg-indigo-600"
            >
              {showAnswer ? 'Hide' : 'Show'} Answer
            </button>
            <button 
              onClick={nextCard}
              disabled={filteredCards.length === 0}
              className="px-6 py-2 bg-gray-200 rounded-lg font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
            >
              Next →
            </button>
          </div>

          {/* Layer Guide */}
          <div className="mt-6 bg-white rounded-lg shadow p-4">
            <h3 className="font-bold text-sm text-gray-700 mb-2">Three-Layer System</h3>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="p-2 bg-blue-50 rounded border-l-2 border-blue-400">
                <strong className="text-blue-700">L1: Recall</strong>
                <p className="text-gray-600 mt-1">Facts, definitions, formulas</p>
              </div>
              <div className="p-2 bg-green-50 rounded border-l-2 border-green-400">
                <strong className="text-green-700">L2: Understanding</strong>
                <p className="text-gray-600 mt-1">Why and how things work</p>
              </div>
              <div className="p-2 bg-red-50 rounded border-l-2 border-red-400">
                <strong className="text-red-700">L3: Boundaries</strong>
                <p className="text-gray-600 mt-1">Limitations and edge cases</p>
              </div>
            </div>
          </div>

          {/* Topic Coverage Grid */}
          <div className="mt-4 bg-white rounded-lg shadow p-4">
            <h3 className="font-bold text-sm text-gray-700 mb-2">Topic Coverage ({flashcards.length} total cards)</h3>
            <div className="grid grid-cols-4 md:grid-cols-5 gap-2">
              {/* Starred tile */}
              <div 
                className={`text-xs p-2 rounded cursor-pointer ${showStarred ? 'bg-yellow-100 border border-yellow-400' : 'bg-yellow-50 hover:bg-yellow-100'}`}
                onClick={() => { setShowStarred(true); setCurrentTopic('all'); resetDeck(); }}
              >
                <div className="font-medium">★ Starred</div>
                <div className="text-yellow-700">{starredIds.length} cards</div>
              </div>
              {/* Topic tiles */}
              {topics.filter(t => t !== 'all').map(topic => (
                <div 
                  key={topic} 
                  className={`text-xs p-2 rounded cursor-pointer ${currentTopic === topic && !showStarred ? 'bg-indigo-100 border border-indigo-300' : 'bg-gray-100 hover:bg-gray-200'}`}
                  onClick={() => { setShowStarred(false); setCurrentTopic(topic); resetDeck(); }}
                >
                  <div className="font-medium truncate">{topicNames[topic] || topic}</div>
                  <div className="text-gray-500">{topicCounts[topic]} cards</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default AtomicFlashcards;
