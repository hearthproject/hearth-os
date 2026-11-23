import { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference
} from "../lib/theme.ts";

const OPTIONS: Array<{
  id: ThemePreference;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  { id: "system", label: "跟随系统", description: "自动使用 Windows 的浅色或深色外观", icon: Monitor },
  { id: "light", label: "浅色", description: "明亮的纸面与暖色强调", icon: Sun },
  { id: "dark", label: "深色", description: "低亮度的深色工作台", icon: Moon }
];

export function AppearanceSettingsPanel() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  useEffect(() => {
    setResolved(applyTheme(preference));
    if (preference !== "system") return;
    return watchSystemTheme(() => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    });
  }, [preference]);

  function choose(next: ThemePreference) {
    setPreference(next);
    saveThemePreference(next);
  }

  return (
    <section className="settings-tab-panel appearance-panel">
      <div className="settings-section-head">
        <h2>外观</h2>
        <p>选择界面的明暗模式。设置会立即生效，并在下次打开 Hearth 时保留。</p>
      </div>
      <div className="appearance-options" role="radiogroup" aria-label="外观模式">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = preference === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`appearance-option ${selected ? "active" : ""}`}
              onClick={() => choose(option.id)}
            >
              <span className="appearance-icon"><Icon size={18} /></span>
              <span className="appearance-copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {selected && <Check className="appearance-check" size={15} />}
            </button>
          );
        })}
      </div>
      <p className="appearance-current">当前显示：{resolved === "dark" ? "深色" : "浅色"}。</p>
    </section>
  );
}
