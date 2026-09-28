interface ImportMetaEnv {
  /** Coordinator origin, e.g. https://coordinator.example.org. Empty means same origin. */
  readonly VITE_COORDINATOR_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
