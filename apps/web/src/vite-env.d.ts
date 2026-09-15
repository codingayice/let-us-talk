/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REALTIME_TEST_ADAPTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
