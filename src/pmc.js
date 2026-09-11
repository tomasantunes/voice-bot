const PMC_URL = "https://pmc.paken.xyz/external/get-data";
const COLLECTIONS = ["folders", "tasks", "recurrent_checks", "events", "daily_todos_tasks", "alerts"];
const MAX_RESULTS = 80;

let cachedData = null;
let loadedAt = null;
let loadPromise = null;
let lastError = null;

function validatePmcData(value) {
  if (!value || typeof value !== "object") throw new Error("PMC returned an invalid response");
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(value[collection])) throw new Error(`PMC response is missing ${collection}`);
  }
  return value;
}

export async function loadPmcData({ force = false } = {}) {
  if (loadPromise) return loadPromise;
  if (cachedData && !force) return cachedData;
  loadPromise = (async () => {
    try {
      const response = await fetch(PMC_URL, {
        headers: { Accept: "application/json", Authorization: process.env.PMC_API_KEY },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`PMC request failed with status ${response.status}`);
      cachedData = validatePmcData(await response.json());
      loadedAt = new Date().toISOString();
      lastError = null;
      return cachedData;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "PMC request failed";
      throw error;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function pmcStatus() {
  return { available: Boolean(cachedData), loadedAt, error: lastError };
}

function isoDate(value) {
  return typeof value === "string" ? value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null : null;
}

function inDateRange(value, startDate, endDate) {
  const date = isoDate(value);
  if (!startDate && !endDate) return true;
  return Boolean(date) && (!startDate || date >= startDate) && (!endDate || date <= endDate);
}

function eventOverlapsRange(event, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const start = isoDate(event.start_date);
  const end = isoDate(event.end_date) || start;
  return Boolean(start) && (!endDate || start <= endDate) && (!startDate || end >= startDate);
}

function cronFieldMatches(field, value, sunday = false) {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    const [first, last = first] = part.split("-").map(Number);
    const adjusted = sunday && value === 0 && (first === 7 || last === 7) ? 7 : value;
    return Number.isInteger(first) && adjusted >= first && adjusted <= last;
  });
}

function alertDatesInRange(cronString, startDate, endDate) {
  if (!startDate && !endDate) return [];
  const parts = String(cronString || "").trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const start = new Date(`${startDate || endDate}T00:00:00Z`);
  const end = new Date(`${endDate || startDate}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return [];
  const dates = [];
  for (let date = start; date <= end && dates.length < 366; date = new Date(date.valueOf() + 86_400_000)) {
    if (cronFieldMatches(parts[3], date.getUTCMonth() + 1) && cronFieldMatches(parts[2], date.getUTCDate()) && cronFieldMatches(parts[4], date.getUTCDay(), true)) {
      dates.push(`${date.toISOString().slice(0, 10)} ${parts[1].padStart(2, "0")}:${parts[0].padStart(2, "0")}`);
    }
  }
  return dates;
}

const QUERY_STOP_WORDS = new Set([
  "a", "about", "alert", "alerts", "all", "an", "and", "any", "are", "calendar", "do", "event", "events", "for", "from", "have", "i", "in", "is", "me", "my", "of", "on", "pmc", "reminder", "reminders", "show", "task", "tasks", "the", "to", "what", "when", "with",
  "alerta", "alertas", "as", "calendario", "compromissos", "de", "do", "dos", "em", "evento", "eventos", "meu", "meus", "minha", "minhas", "o", "os", "para", "que", "tarefas", "tenho"
]);

function normalized(value) {
  return String(value || "").toLocaleLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function queryTerms(query) {
  return (normalized(query).match(/[\p{L}\p{N}]+/gu) || []).filter((term) => term.length > 1 && !QUERY_STOP_WORDS.has(term));
}

function matchesTerms(value, terms) {
  if (!terms.length) return true;
  const text = normalized(Object.values(value).filter((field) => typeof field === "string" || typeof field === "number").join(" "));
  return terms.every((term) => text.includes(term));
}

function selectCategories(categories) {
  if (!Array.isArray(categories) || !categories.length || categories.includes("all")) return new Set(["folders", "tasks", "calendar", "alerts"]);
  return new Set(categories);
}

function sortByRelevantDate(left, right) {
  const leftDate = left.tdate || left.start_date || left.expiration_date || left.created_at || "";
  const rightDate = right.tdate || right.start_date || right.expiration_date || right.created_at || "";
  return String(rightDate).localeCompare(String(leftDate));
}

export async function searchPmc({ query = "", categories = ["all"], startDate = "", endDate = "", includeDone = false } = {}) {
  const data = cachedData || await loadPmcData();
  const selected = selectCategories(categories);
  const terms = queryTerms(query);
  const foldersById = new Map(data.folders.map((folder) => [folder.id, folder]));
  const tasksById = new Map(data.tasks.map((task) => [task.id, task]));
  const results = [];

  if (selected.has("folders")) {
    for (const folder of data.folders) if (matchesTerms(folder, terms)) results.push({ kind: "folder", ...folder });
  }
  if (selected.has("tasks")) {
    for (const task of data.tasks) {
      const enriched = { ...task, folder_name: foldersById.get(task.folder_id)?.name || null };
      if ((includeDone || !Number(task.is_done)) && inDateRange(task.expiration_date, startDate, endDate) && matchesTerms(enriched, terms)) results.push({ kind: "task", ...enriched });
    }
    for (const task of data.daily_todos_tasks) {
      const enriched = { ...task, folder_name: foldersById.get(task.folder_id)?.name || null };
      if ((includeDone || !Number(task.is_done)) && inDateRange(task.tdate, startDate, endDate) && matchesTerms(enriched, terms)) results.push({ kind: "daily_todo", ...enriched });
    }
    if (startDate || endDate || terms.length) {
      for (const check of data.recurrent_checks) {
        const task = tasksById.get(check.task_id);
        const enriched = { ...check, task_description: task?.description || null, folder_name: task ? foldersById.get(task.folder_id)?.name || null : null };
        if ((includeDone || !Number(check.is_done)) && !Number(check.is_cancelled) && inDateRange(check.date, startDate, endDate) && matchesTerms(enriched, terms)) results.push({ kind: "recurrent_check", ...enriched });
      }
    }
  }
  if (selected.has("calendar")) {
    for (const event of data.events) {
      const task = tasksById.get(event.task_id);
      const enriched = { ...event, task_description: task?.description || null, folder_name: task ? foldersById.get(task.folder_id)?.name || null : null };
      if (eventOverlapsRange(event, startDate, endDate) && matchesTerms(enriched, terms)) results.push({ kind: "calendar_event", ...enriched });
    }
  }
  if (selected.has("alerts")) {
    for (const alert of data.alerts) {
      const scheduledDates = alertDatesInRange(alert.cron_string, startDate, endDate);
      const enriched = { ...alert, task_description: tasksById.get(alert.task_id)?.description || null, scheduled_dates: scheduledDates };
      if ((!startDate && !endDate || scheduledDates.length) && matchesTerms(enriched, terms)) results.push({ kind: "alert", ...enriched });
    }
  }

  results.sort(sortByRelevantDate);
  return {
    source: "PMC",
    loaded_at: loadedAt,
    query: { text: query, categories: [...selected], start_date: startDate || null, end_date: endDate || null, include_done: includeDone },
    total_matches: results.length,
    truncated: results.length > MAX_RESULTS,
    results: results.slice(0, MAX_RESULTS)
  };
}
