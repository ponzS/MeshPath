import { ref, computed } from 'vue'

// Simple global language store (default to English). Persisted in localStorage.
const stored = (typeof localStorage !== 'undefined' ? localStorage.getItem('meshpath_lang') : '') || 'en'
const langRef = ref<'en' | 'zh'>(stored === 'zh' ? 'zh' : 'en')

function setLang(l: 'en' | 'zh') {
  langRef.value = l
  try { localStorage.setItem('meshpath_lang', l) } catch (_) { /* ignore */ }
}

const isZh = computed(() => langRef.value === 'zh')

export function useLang() {
  return {
    lang: langRef,
    isZh,
    setLang,
    toggle: () => setLang(isZh.value ? 'en' : 'zh'),
  }
}