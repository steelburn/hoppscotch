import { Service } from "dioc"
import type { RelayRequest } from "@hoppscotch/kernel"
import { Store } from "~/kernel/store"
import * as E from "fp-ts/Either"
import {
  InputDomainSetting,
  convertDomainSetting,
} from "~/helpers/functional/domain-settings"

const STORE_NAMESPACE = "interceptors.native.v1"

const STORE_KEYS = {
  SETTINGS: "settings",
} as const

interface StoredData {
  version: string
  domains: Record<string, InputDomainSetting>
  lastUpdated: string
}

const defaultDomainConfig: InputDomainSetting = {
  version: "v1",
  security: {
    verifyHost: true,
    verifyPeer: true,
  },
  proxy: undefined,
}

export class KernelInterceptorNativeStore extends Service {
  public static readonly ID = "KERNEL_NATIVE_INTERCEPTOR_STORE"
  private static readonly GLOBAL_DOMAIN = "*"
  private static readonly DEFAULT_GLOBAL_SETTINGS: InputDomainSetting = {
    ...defaultDomainConfig,
    version: "v1",
  }

  private domainSettings = new Map<string, InputDomainSetting>()

  async onServiceInit(): Promise<void> {
    const initResult = await Store.init()
    if (E.isLeft(initResult)) {
      console.error(
        "[NativeStore] Failed to initialize store:",
        initResult.left
      )
      return
    }

    await this.loadStore()
    this.setupWatchers()
  }

  private async loadStore(): Promise<void> {
    const loadResult = await Store.get<StoredData>(
      STORE_NAMESPACE,
      STORE_KEYS.SETTINGS
    )

    if (E.isRight(loadResult) && loadResult.right) {
      const storedData = loadResult.right
      this.domainSettings = new Map(Object.entries(storedData.domains))
    }

    if (!this.domainSettings.has(KernelInterceptorNativeStore.GLOBAL_DOMAIN)) {
      this.domainSettings.set(
        KernelInterceptorNativeStore.GLOBAL_DOMAIN,
        KernelInterceptorNativeStore.DEFAULT_GLOBAL_SETTINGS
      )
      await this.persistStore()
    }
  }

  private async setupWatchers() {
    const watcher = await Store.watch(STORE_NAMESPACE, STORE_KEYS.SETTINGS)
    watcher.on("change", async ({ value }) => {
      if (value) {
        const store = value as StoredData
        this.domainSettings = new Map(Object.entries(store.domains))
      }
    })
  }

  private async persistStore(): Promise<void> {
    const store: StoredData = {
      version: "v1",
      domains: Object.fromEntries(this.domainSettings),
      lastUpdated: new Date().toISOString(),
    }

    const saveResult = await Store.set(
      STORE_NAMESPACE,
      STORE_KEYS.SETTINGS,
      store
    )
    if (E.isLeft(saveResult)) {
      console.error("[AgentStore] Failed to save store:", saveResult.left)
    }
  }

  private mergeSecurity(
    ...settings: (Required<InputDomainSetting>["security"] | undefined)[]
  ): Required<InputDomainSetting>["security"] | undefined {
    return settings.reduce(
      (acc, setting) => (setting ? { ...acc, ...setting } : acc),
      undefined as Required<RelayRequest>["security"] | undefined
    )
  }

  private mergeProxy(
    ...settings: (Required<InputDomainSetting>["proxy"] | undefined)[]
  ): Required<InputDomainSetting>["proxy"] | undefined {
    return settings.reduce(
      (acc, setting) => (setting ? { ...acc, ...setting } : acc),
      undefined as Required<InputDomainSetting>["proxy"] | undefined
    )
  }

  private getMergedSettings(domain: string): InputDomainSetting {
    const domainSettings = this.domainSettings.get(domain)
    const globalSettings =
      domain !== KernelInterceptorNativeStore.GLOBAL_DOMAIN
        ? this.domainSettings.get(KernelInterceptorNativeStore.GLOBAL_DOMAIN)
        : undefined

    const result = {
      security: this.mergeSecurity(
        globalSettings?.security,
        domainSettings?.security
      ),
      proxy: this.mergeProxy(globalSettings?.proxy, domainSettings?.proxy),
    }

    return { version: "v1", ...result }
  }

  public completeRequest(
    request: Omit<RelayRequest, "proxy" | "security">
  ): RelayRequest {
    const host = new URL(request.url).host
    const settings = this.getMergedSettings(host)
    const effective = convertDomainSetting(settings)

    if (E.isLeft(effective)) {
      throw effective.left
    }

    return { ...request, ...effective.right }
  }

  public getDomainSettings(domain: string): InputDomainSetting {
    return (
      this.domainSettings.get(domain) ?? {
        ...defaultDomainConfig,
        version: "v1",
      }
    )
  }

  public async saveDomainSettings(
    domain: string,
    settings: Partial<InputDomainSetting>
  ): Promise<void> {
    const updatedSettings: InputDomainSetting = {
      ...settings,
      version: "v1",
    }

    this.domainSettings.set(domain, updatedSettings)
    await this.persistStore()
  }

  public async clearDomainSettings(domain: string): Promise<void> {
    this.domainSettings.delete(domain)
    await this.persistStore()
  }

  public getDomains(): string[] {
    return Array.from(this.domainSettings.keys())
  }

  public getAllDomainSettings(): Map<string, InputDomainSetting> {
    return new Map(this.domainSettings)
  }
}
