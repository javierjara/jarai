import type { JaraiBridge } from './index';

declare global {
  interface Window {
    jarai: JaraiBridge;
  }
}
