/** Name Studio の表示設定を、既存 Book Reader の純ページ送りへ接続する。 */
import {
  DEFAULT_BOOK_READER_SETTINGS,
  type BookReaderFitMode,
  type BookReaderLayout,
  type BookReaderSettings
} from "./bookReader";

export type NameStudioFitMode = Extract<BookReaderFitMode, "fit-height" | "fit-width">;

export interface NameStudioReaderOptions {
  layout: BookReaderLayout;
  fitMode: NameStudioFitMode;
}

export const DEFAULT_NAME_STUDIO_READER_OPTIONS: NameStudioReaderOptions = {
  layout: "single",
  fitMode: "fit-height"
};

/** Name Studio は日本漫画の右綴じで、見開きは1ページ目から開始する。 */
export function nameStudioReaderSettings(options: NameStudioReaderOptions): BookReaderSettings {
  return {
    ...DEFAULT_BOOK_READER_SETTINGS,
    direction: "rtl",
    layout: options.layout,
    spreadStartIndex: 1,
    fitMode: options.fitMode
  };
}
