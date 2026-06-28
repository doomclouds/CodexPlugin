import { useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsOutSimple,
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartBar,
  Check,
  Cloud,
  DotsThreeVertical,
  Heart,
  ImageSquare,
  Leaf,
  LinkSimple,
  ListBullets,
  ListNumbers,
  Moon,
  MusicNote,
  Pause,
  Play,
  Quotes,
  Sparkle,
  SpeakerHigh,
  Sun,
  Target,
  TextB,
  TextItalic,
  TextUnderline,
  Timer,
  WaveSine,
} from "@phosphor-icons/react";

import avatarWarm from "./assets/generated/avatar-warm-160.png";
import botanicalCorner from "./assets/generated/botanical-corner-512.png";
import memoryGrateful from "./assets/generated/memory-grateful-heart-320x220.png";
import memoryMorning from "./assets/generated/memory-morning-320x220.png";
import memoryPerspective from "./assets/generated/memory-new-perspective-320x220.png";
import memoryReset from "./assets/generated/memory-reset-realign-320x220.png";
import memorySlow from "./assets/generated/memory-slow-smooth-320x220.png";
import memorySmallWins from "./assets/generated/memory-small-wins-320x220.png";
import noteSlip from "./assets/generated/note-slip-360x220.png";
import noteSlipSmall from "./assets/generated/note-slip-small-360x180.png";
import noteSlipTall from "./assets/generated/note-slip-tall-360x260.png";
import paperTexture from "./assets/generated/paper-texture-warm-ivory-1024.png";
import paperclipSet from "./assets/generated/paperclip-set-512.png";
import pressedFlowerTape from "./assets/generated/pressed-flower-tape-512.png";
import sunlitDesk from "./assets/generated/sunlit-desk-bg-1536x1024.png";
import washiTape from "./assets/generated/washi-tape-set-512.png";

const memories = [
  {
    id: "morning",
    date: "TODAY",
    day: "May 15",
    time: "7:32 AM",
    title: "Morning clarity",
    mood: "Calm",
    color: "sage",
    image: memoryMorning,
  },
  {
    id: "grateful",
    date: "WED",
    day: "May 14",
    time: "7:28 AM",
    title: "Grateful heart",
    mood: "Grateful",
    color: "lavender",
    image: memoryGrateful,
  },
  {
    id: "wins",
    date: "TUE",
    day: "May 13",
    time: "7:15 AM",
    title: "Small wins",
    mood: "Motivated",
    color: "gold",
    image: memorySmallWins,
  },
  {
    id: "reset",
    date: "MON",
    day: "May 12",
    time: "7:07 AM",
    title: "Reset & realign",
    mood: "Peaceful",
    color: "cyan",
    image: memoryReset,
  },
  {
    id: "slow",
    date: "SUN",
    day: "May 11",
    time: "7:18 AM",
    title: "Slow is smooth",
    mood: "Mindful",
    color: "sage",
    image: memorySlow,
  },
  {
    id: "perspective",
    date: "SAT",
    day: "May 10",
    time: "7:22 AM",
    title: "New perspective",
    mood: "Inspired",
    color: "coral",
    image: memoryPerspective,
  },
];

const moodOptions = [
  { id: "Calm", icon: Leaf },
  { id: "Grateful", icon: Heart },
  { id: "Motivated", icon: Sun },
  { id: "Tired", icon: Moon },
  { id: "Anxious", icon: Cloud },
];

const gratitudeItems = [
  "The morning light",
  "My health and energy",
  "People who inspire me",
];

const focusItems = [
  "Deep work on project",
  "Move my body",
  "Connect with a friend",
];

export function App() {
  const [selectedMemory, setSelectedMemory] = useState("morning");
  const [selectedMood, setSelectedMood] = useState("Calm");
  const [energy, setEnergy] = useState(7);
  const [entryText, setEntryText] = useState("");
  const [flowMode, setFlowMode] = useState(true);
  const [timerRunning, setTimerRunning] = useState(false);
  const [checkedFocus, setCheckedFocus] = useState(["Deep work on project"]);

  const activeMemory = memories.find((memory) => memory.id === selectedMemory);
  const wordCount = useMemo(() => {
    return entryText.trim() ? entryText.trim().split(/\s+/).length : 0;
  }, [entryText]);
  const saveStatus = entryText ? "Saving..." : "Saved";

  function toggleFocus(item) {
    setCheckedFocus((current) =>
      current.includes(item)
        ? current.filter((value) => value !== item)
        : [...current, item],
    );
  }

  return (
    <main
      className="journal-app"
      style={{
        "--asset-desk": `url(${sunlitDesk})`,
        "--asset-paper": `url(${paperTexture})`,
      }}
    >
      <img className="botanical botanical-top" src={botanicalCorner} alt="" />
      <img className="botanical botanical-bottom" src={botanicalCorner} alt="" />

      <TopBar flowMode={flowMode} setFlowMode={setFlowMode} saveStatus={saveStatus} />

      <section className="workspace" aria-label="Morning journal workspace">
        <MemoryTrail
          selectedMemory={selectedMemory}
          setSelectedMemory={setSelectedMemory}
        />
        <WritingSanctuary
          activeMemory={activeMemory}
          entryText={entryText}
          setEntryText={setEntryText}
          wordCount={wordCount}
        />
        <RhythmPanel
          selectedMood={selectedMood}
          setSelectedMood={setSelectedMood}
          energy={energy}
          setEnergy={setEnergy}
          checkedFocus={checkedFocus}
          toggleFocus={toggleFocus}
        />
      </section>

      <FlowStrip
        flowMode={flowMode}
        timerRunning={timerRunning}
        setTimerRunning={setTimerRunning}
      />
    </main>
  );
}

function TopBar({ flowMode, setFlowMode, saveStatus }) {
  return (
    <header className="topbar" aria-label="Journal controls">
      <div className="brand">
        <h1>Sunlit Memory Flow</h1>
        <p>Morning Journal</p>
      </div>

      <div className="date-nav" aria-label="Date navigation">
        <button className="icon-button ghost" type="button" aria-label="Previous day">
          <CaretLeft size={20} weight="regular" />
        </button>
        <div className="date-chip">
          <Sun size={24} weight="regular" />
          <div>
            <strong>Today</strong>
            <span>May 15, 2025 · Thursday</span>
          </div>
        </div>
        <button className="icon-button ghost" type="button" aria-label="Next day">
          <CaretRight size={20} weight="regular" />
        </button>
      </div>

      <div className="top-actions">
        <button
          className={`flow-toggle ${flowMode ? "active" : ""}`}
          type="button"
          aria-pressed={flowMode}
          onClick={() => setFlowMode(!flowMode)}
        >
          <Leaf size={18} weight="regular" />
          <span>Flow Mode</span>
          <span className="toggle-knob" />
        </button>

        <div className="toolbar-cluster" aria-label="Journal utility tools">
          <button className="icon-button" type="button" aria-label="Stats">
            <ChartBar size={20} />
          </button>
          <button className="icon-button" type="button" aria-label="Ritual sparkle">
            <Sparkle size={20} />
          </button>
          <button className="icon-button" type="button" aria-label="More options">
            <DotsThreeVertical size={20} />
          </button>
        </div>

        <div className="save-profile">
          <Check size={18} weight="bold" />
          <div>
            <strong>{saveStatus}</strong>
            <span>9:41 AM</span>
          </div>
          <img src={avatarWarm} alt="Profile" />
        </div>
      </div>
    </header>
  );
}

function MemoryTrail({ selectedMemory, setSelectedMemory }) {
  return (
    <aside className="memory-panel" aria-label="Memory Trail">
      <div className="panel-title">
        <Leaf size={20} />
        <h2>Memory Trail</h2>
      </div>
      <div className="memory-list">
        {memories.map((memory) => (
          <button
            key={memory.id}
            className={`memory-card ${selectedMemory === memory.id ? "selected" : ""}`}
            type="button"
            onClick={() => setSelectedMemory(memory.id)}
          >
            <span className={`timeline-dot ${memory.color}`} />
            <span className="memory-date">
              {memory.date} <span>·</span> {memory.day}
            </span>
            <span className="memory-content">
              <img src={memory.image} alt="" />
              <span className="memory-copy">
                <span className="memory-time">{memory.time}</span>
                <strong>{memory.title}</strong>
                <span className="mood-line">
                  <span className={`mood-dot ${memory.color}`} />
                  {memory.mood}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <button className="view-all" type="button">
        <CalendarBlank size={17} />
        View all entries
      </button>
    </aside>
  );
}

function WritingSanctuary({ activeMemory, entryText, setEntryText, wordCount }) {
  return (
    <section className="editor-panel" aria-label="Writing sanctuary">
      <img className="editor-tape" src={pressedFlowerTape} alt="" />
      <div className="editor-header">
        <div>
          <p>Morning Prompt</p>
          <h2>What would make today meaningful?</h2>
        </div>
        <div className="focus-tools">
          <span>
            <Leaf size={17} />
            Focus Mode
          </span>
          <button className="icon-button ghost" type="button" aria-label="Expand editor">
            <ArrowsOutSimple size={20} />
          </button>
        </div>
      </div>
      <div className="rule" />
      <label className="editor-label" htmlFor="journal-entry">
        Start writing...
        <span className="sr-only"> Current entry: {activeMemory?.title}</span>
      </label>
      <textarea
        id="journal-entry"
        value={entryText}
        onChange={(event) => setEntryText(event.target.value)}
        placeholder="Start writing..."
      />
      <div className="editor-toolbar" aria-label="Editor toolbar">
        <div className="format-actions">
          <button type="button" aria-label="Bold">
            <TextB size={21} weight="bold" />
          </button>
          <button type="button" aria-label="Italic">
            <TextItalic size={21} />
          </button>
          <button type="button" aria-label="Underline">
            <TextUnderline size={21} />
          </button>
          <span className="toolbar-divider" />
          <button type="button" aria-label="Bulleted list">
            <ListBullets size={21} />
          </button>
          <button type="button" aria-label="Numbered list">
            <ListNumbers size={21} />
          </button>
          <button type="button" aria-label="Insert image">
            <ImageSquare size={21} />
          </button>
          <button type="button" aria-label="Insert link">
            <LinkSimple size={21} />
          </button>
          <button type="button" aria-label="Quote">
            <Quotes size={21} />
          </button>
        </div>
        <div className="format-actions">
          <button type="button" aria-label="Undo">
            <ArrowCounterClockwise size={20} />
          </button>
          <button type="button" aria-label="Redo">
            <ArrowClockwise size={20} />
          </button>
          <span className="word-count">{wordCount} words</span>
        </div>
      </div>
    </section>
  );
}

function RhythmPanel({
  selectedMood,
  setSelectedMood,
  energy,
  setEnergy,
  checkedFocus,
  toggleFocus,
}) {
  return (
    <aside className="rhythm-panel" aria-label="My Rhythm">
      <img className="rhythm-flower" src={pressedFlowerTape} alt="" />
      <div className="panel-title rhythm-title">
        <Leaf size={20} />
        <h2>My Rhythm</h2>
      </div>

      <section
        className="note-section mood-section"
        style={{ "--note-bg": `url(${noteSlipSmall})` }}
      >
        <h3>Mood</h3>
        <p>How are you feeling?</p>
        <div className="mood-grid">
          {moodOptions.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`mood-chip ${selectedMood === id ? "selected" : ""}`}
              type="button"
              aria-pressed={selectedMood === id}
              onClick={() => setSelectedMood(id)}
            >
              <Icon size={26} weight="regular" />
              <span>{id}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="note-section" style={{ "--note-bg": `url(${noteSlipSmall})` }}>
        <div className="section-row">
          <div>
            <h3>Energy</h3>
            <p>How is your energy today?</p>
          </div>
          <strong>{energy} / 10</strong>
        </div>
        <input
          className="energy-slider"
          type="range"
          min="0"
          max="10"
          value={energy}
          onChange={(event) => setEnergy(Number(event.target.value))}
          aria-label="Energy level"
        />
      </section>

      <section className="note-section" style={{ "--note-bg": `url(${noteSlip})` }}>
        <img className="note-tape left" src={washiTape} alt="" />
        <h3>Intention</h3>
        <p>What is your intention for today?</p>
        <textarea
          className="mini-textarea"
          defaultValue="I choose to focus on what truly matters."
          aria-label="Daily intention"
        />
        <Leaf className="note-leaf" size={25} />
      </section>

      <section className="note-section" style={{ "--note-bg": `url(${noteSlipTall})` }}>
        <img className="note-tape right" src={washiTape} alt="" />
        <h3>Gratitude</h3>
        <p>What are you grateful for?</p>
        <ol className="soft-list">
          {gratitudeItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>

      <section className="note-section focus-section" style={{ "--note-bg": `url(${noteSlipTall})` }}>
        <img className="paperclip" src={paperclipSet} alt="" />
        <div className="section-row">
          <div>
            <h3>Today's Focus</h3>
            <p>Top 3 priorities</p>
          </div>
          <Target size={24} />
        </div>
        <div className="focus-list">
          {focusItems.map((item, index) => {
            const active = checkedFocus.includes(item);
            return (
              <button
                key={item}
                className={`focus-item ${active ? "checked" : ""}`}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFocus(item)}
              >
                <span>{index + 1}</span>
                {item}
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

function FlowStrip({ flowMode, timerRunning, setTimerRunning }) {
  return (
    <footer className="flow-strip" aria-label="Focus flow controls">
      <div className="flow-group state">
        <Target size={34} />
        <div>
          <strong>Flow State</strong>
          <span>{flowMode ? "You're in a focused state" : "Ready when you are"}</span>
        </div>
        <WaveSine className="wave" size={92} />
      </div>
      <div className="flow-group sound">
        <MusicNote size={25} />
        <div>
          <strong>Focus Sound</strong>
          <span>Morning Piano</span>
        </div>
        <CaretDown size={16} />
        <SpeakerHigh size={18} />
        <div className="volume">
          <span />
        </div>
      </div>
      <div className="flow-group timer-block">
        <span className="timer-value">25:00</span>
        <button
          className="start-button"
          type="button"
          onClick={() => setTimerRunning(!timerRunning)}
        >
          {timerRunning ? <Pause size={20} weight="fill" /> : <Play size={20} weight="fill" />}
          {timerRunning ? "Pause" : "Start"}
        </button>
        <button className="timer-icon" type="button" aria-label="Timer settings">
          <Timer size={23} />
        </button>
      </div>
      <div className="flow-group progress">
        <Sun size={26} />
        <div>
          <strong>Morning Progress</strong>
          <div className="progress-row">
            <span className="progress-track">
              <span />
            </span>
            <small>32%</small>
          </div>
        </div>
      </div>
      <blockquote className="quote-card">
        <span>Clarity comes</span>
        <span>when we slow down.</span>
        <img src={botanicalCorner} alt="" />
      </blockquote>
    </footer>
  );
}
