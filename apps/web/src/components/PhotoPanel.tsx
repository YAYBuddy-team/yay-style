import type { PersonAnalysis } from "@yay/tryon";

interface Props {
  person: PersonAnalysis | null;
  status: string | null;
  error: string | null;
  onFile: (file: File) => void;
}

export function PhotoPanel({ person, status, error, onFile }: Props) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">1. Ваше фото</h2>
      <label className="block cursor-pointer rounded-xl border-2 border-dashed border-neutral-300 p-4 text-center hover:border-neutral-500">
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        <span className="text-sm">{person ? "Заменить фото" : "Загрузить фото в полный рост"}</span>
      </label>
      <p className="text-xs leading-relaxed text-neutral-500">
        Лучше всего: в облегающей одежде с коротким рукавом (майка, футболка, лосины или шорты), лицом к
        камере, руки чуть в стороны, на однотонном фоне. Своя свободная одежда будет видна из-под примеряемой.
        Фото обрабатывается прямо в браузере и никуда не отправляется.
      </p>
      {status && <p className="text-sm text-neutral-600">{status}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {person && person.issues.length === 0 && (
        <p className="text-sm text-emerald-700">Фото подходит для примерки</p>
      )}
      {person && person.issues.length > 0 && (
        <ul className="space-y-1 text-sm">
          {person.issues.map((i) => (
            <li key={i.code + i.message} className={i.severity === "error" ? "text-red-600" : "text-amber-700"}>
              {i.severity === "error" ? "✕ " : "! "}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
