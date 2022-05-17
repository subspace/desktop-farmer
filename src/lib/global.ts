import { reactive } from "vue";
import { getLang, LangType } from "../loc/lang"
import { appConfig } from "./appConfig";

const text: LangType = {}
// TODO use dependency injection to ensure methods and properties can't be accessed unless they are initialized and valid
export class Global {
  data = reactive({ status: { state: "loading", message: "loading" }, loc: { selected: 'en', text } })
  async changeLang(newLang: string): Promise<void> {
    this.data.loc.selected = newLang
    await this.loadLangData()
  }
  async loadLangData(): Promise<void> {
    this.data.loc.text = await getLang(this.data.loc.selected)
  }
  async init(): Promise<void> {
    await appConfig.init()
    await this.loadLangData()
  }
}

export const globalState = new Global

