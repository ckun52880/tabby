import { Injectable, Inject } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { NewTabParameters } from './tabs.service'
import { BaseTabComponent } from '../components/baseTab.component'
import { PartialProfile, PartialProfileGroup, Profile, ProfileGroup, ProfileProvider } from '../api/profileProvider'
import { SelectorOption } from '../api/selector'
import { AppService } from './app.service'
import { configMerge, ConfigProxy, ConfigService } from './config.service'
import { NotificationsService } from './notifications.service'
import { SelectorService } from './selector.service'

@Injectable({ providedIn: 'root' })
export class ProfilesService {
    private profileDefaults = {
        id: '',
        type: '',
        name: '',
        group: '',
        options: {},
        icon: '',
        color: '',
        disableDynamicTitle: false,
        weight: 0,
        isBuiltin: false,
        isTemplate: false,
        terminalColorScheme: null,
        behaviorOnSessionEnd: 'auto',
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        private notifications: NotificationsService,
        private selector: SelectorService,
        private translate: TranslateService,
        @Inject(ProfileProvider) private profileProviders: ProfileProvider<Profile>[],
    ) { }

    async openNewTabForProfile <P extends Profile> (profile: PartialProfile<P>): Promise<BaseTabComponent|null> {
        const params = await this.newTabParametersForProfile(profile)
        if (params) {
            return this.app.openNewTab(params)
        }
        return null
    }

    async newTabParametersForProfile <P extends Profile> (profile: PartialProfile<P>): Promise<NewTabParameters<BaseTabComponent>|null> {
        const fullProfile = this.getConfigProxyForProfile(profile)
        const params = await this.providerForProfile(fullProfile)?.getNewTabParameters(fullProfile) ?? null
        if (params) {
            params.inputs ??= {}
            params.inputs['title'] = profile.name
            if (fullProfile.disableDynamicTitle) {
                params.inputs['disableDynamicTitle'] = true
            }
            if (fullProfile.color) {
                params.inputs['color'] = fullProfile.color
            }
            if (fullProfile.icon) {
                params.inputs['icon'] = fullProfile.icon
            }
        }
        return params
    }

    getProviders (): ProfileProvider<Profile>[] {
        return [...this.profileProviders]
    }

    async getProfiles (): Promise<PartialProfile<Profile>[]> {
        const lists = await Promise.all(this.config.enabledServices(this.profileProviders).map(x => x.getBuiltinProfiles()))
        let list = lists.reduce((a, b) => a.concat(b), [])
        list = [
            ...this.config.store.profiles ?? [],
            ...list,
        ]
        const sortKey = p => `${p.group ?? ''} / ${p.name}`
        list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
        list.sort((a, b) => (a.isBuiltin ? 1 : 0) - (b.isBuiltin ? 1 : 0))
        return list
    }



    providerForProfile <T extends Profile> (profile: PartialProfile<T>): ProfileProvider<T>|null {
        const provider = this.profileProviders.find(x => x.id === profile.type) ?? null
        return provider as unknown as ProfileProvider<T>|null
    }

    getDescription <P extends Profile> (profile: PartialProfile<P>): string|null {
        profile = this.getConfigProxyForProfile(profile)
        return this.providerForProfile(profile)?.getDescription(profile) ?? null
    }

    selectorOptionForProfile <P extends Profile, T> (profile: PartialProfile<P>): SelectorOption<T> {
        const fullProfile = this.getConfigProxyForProfile(profile)
        const provider = this.providerForProfile(fullProfile)
        const freeInputEquivalent = provider?.intoQuickConnectString(fullProfile) ?? undefined
        return {
            ...profile,
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            group: profile.group || '',
            freeInputEquivalent,
            description: provider?.getDescription(fullProfile),
        }
    }

    getRecentProfiles (): PartialProfile<Profile>[] {
        let recentProfiles: PartialProfile<Profile>[] = JSON.parse(window.localStorage['recentProfiles'] ?? '[]')
        recentProfiles = recentProfiles.slice(0, this.config.store.terminal.showRecentProfiles)
        return recentProfiles
    }

    showProfileSelector (): Promise<PartialProfile<Profile>|null> {
        if (this.selector.active) {
            return Promise.resolve(null)
        }

        return new Promise<PartialProfile<Profile>|null>(async (resolve, reject) => {
            try {
                const recentProfiles = this.getRecentProfiles()

                let options: SelectorOption<void>[] = recentProfiles.map((p, i) => ({
                    ...this.selectorOptionForProfile(p),
                    group: this.translate.instant('Recent'),
                    icon: 'fas fa-history',
                    color: p.color,
                    weight: i - (recentProfiles.length + 1),
                    callback: async () => {
                        if (p.id) {
                            p = (await this.getProfiles()).find(x => x.id === p.id) ?? p
                        }
                        resolve(p)
                    },
                }))
                if (recentProfiles.length) {
                    options.push({
                        name: this.translate.instant('Clear recent profiles'),
                        group: this.translate.instant('Recent'),
                        icon: 'fas fa-eraser',
                        weight: -1,
                        callback: async () => {
                            window.localStorage.removeItem('recentProfiles')
                            this.config.save()
                            resolve(null)
                        },
                    })
                }

                let profiles = await this.getProfiles()

                if (!this.config.store.terminal.showBuiltinProfiles) {
                    profiles = profiles.filter(x => !x.isBuiltin)
                }

                profiles = profiles.filter(x => !x.isTemplate)

                profiles = profiles.filter(x => x.id && !this.config.store.profileBlacklist.includes(x.id))

                options = [...options, ...profiles.map((p): SelectorOption<void> => ({
                    ...this.selectorOptionForProfile(p),
                    weight: p.isBuiltin ? 2 : 1,
                    callback: () => resolve(p),
                }))]

                try {
                    const { SettingsTabComponent } = window['nodeRequire']('tabby-settings')
                    options.push({
                        name: this.translate.instant('Manage profiles'),
                        icon: 'fas fa-window-restore',
                        weight: 10,
                        callback: () => {
                            this.app.openNewTabRaw({
                                type: SettingsTabComponent,
                                inputs: { activeTab: 'profiles' },
                            })
                            resolve(null)
                        },
                    })
                } catch { }

                this.getProviders().filter(x => x.supportsQuickConnect).forEach(provider => {
                    options.push({
                        name: this.translate.instant('Quick connect'),
                        freeInputPattern: this.translate.instant('Connect to "%s"...'),
                        description: `(${provider.name.toUpperCase()})`,
                        icon: 'fas fa-arrow-right',
                        weight: provider.id !== this.config.store.defaultQuickConnectProvider ? 1 : 0,
                        callback: query => {
                            const profile = provider.quickConnect(query)
                            resolve(profile)
                        },
                    })
                })

                await this.selector.show(this.translate.instant('Select profile or enter an address'), options)
            } catch (err) {
                reject(err)
            }
        })
    }

    async quickConnect (query: string): Promise<PartialProfile<Profile>|null> {
        for (const provider of this.getProviders()) {
            if (provider.supportsQuickConnect) {
                const profile = provider.quickConnect(query)
                if (profile) {
                    return profile
                }
            }
        }
        this.notifications.error(`Could not parse "${query}"`)
        return null
    }

    getConfigProxyForProfile <T extends Profile> (profile: PartialProfile<T>, skipUserDefaults = false): T {
        const defaults = this.getProfileDefaults(profile).reduce(configMerge, {})
        return new ConfigProxy(profile, defaults) as unknown as T
    }

    async launchProfile (profile: PartialProfile<Profile>): Promise<void> {
        await this.openNewTabForProfile(profile)

        let recentProfiles: PartialProfile<Profile>[] = JSON.parse(window.localStorage['recentProfiles'] ?? '[]')
        if (this.config.store.terminal.showRecentProfiles > 0) {
            recentProfiles = recentProfiles.filter(x => x.group !== profile.group || x.name !== profile.name)
            recentProfiles.unshift(profile)
            recentProfiles = recentProfiles.slice(0, this.config.store.terminal.showRecentProfiles)
        } else {
            recentProfiles = []
        }
        window.localStorage['recentProfiles'] = JSON.stringify(recentProfiles)
    }

    /*
    * Methods used to interract with Profile/ProfileGroup/Global defaults
    */

    /**
    * Return global defaults for a given profile provider
    * Always return something, empty object if no defaults found
    */
    getProviderDefaults (provider: ProfileProvider<Profile>): any {
        const defaults = this.config.store.profileDefaults
        return defaults[provider.id] ?? {}
    }

    /**
    * Set global defaults for a given profile provider
    */
    setProviderDefaults (provider: ProfileProvider<Profile>, pdefaults: any) {
        this.config.store.profileDefaults[provider.id] = pdefaults
    }

    /**
    * Return defaults for a given profile
    * Always return something, empty object if no defaults found
    */
    getProfileDefaults (profile: PartialProfile<Profile>, skipUserDefaults = false): any {
        const provider = this.providerForProfile(profile)
        return [
            this.profileDefaults,
            provider?.configDefaults ?? {},
            !provider || skipUserDefaults ? {} : this.getProviderDefaults(provider),
        ]
    }

    /*
    * Methods used to interract with ProfileGroup
    */

    /**
    * Return an Array of the existing ProfileGroups
    * arg: includeProfiles (default: false) -> if false, does not fill up the profiles field of ProfileGroup
    * arg: includeNonUserGroup (default: false) -> if false, does not add built-in and ungrouped groups
    */
    async getProfileGroups (includeProfiles = false, includeNonUserGroup = false): Promise<PartialProfileGroup<ProfileGroup>[]> {
        let profiles: PartialProfile<Profile>[] = []
        if (includeProfiles) {
            profiles = await this.getProfiles()
        }

        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        let groups: PartialProfileGroup<ProfileGroup>[] = this.config.store.groups ?? []
        groups = groups.map(x => {
            x.editable = true
            x.collapsed = profileGroupCollapsed[x.id ?? ''] ?? false

            if (includeProfiles) {
                x.profiles = profiles.filter(p => p.group === x.id)
                profiles = profiles.filter(p => p.group !== x.id)
            }

            return x
        })

        if (includeNonUserGroup) {
            const builtIn: PartialProfileGroup<ProfileGroup> = {
                id: 'built-in',
                name: this.translate.instant('Built-in'),
                editable: false,
            }
            builtIn.collapsed = profileGroupCollapsed[builtIn.id] ?? false

            const ungrouped: PartialProfileGroup<ProfileGroup> = {
                id: 'ungrouped',
                name: this.translate.instant('Ungrouped'),
                editable: false,
            }
            ungrouped.collapsed = profileGroupCollapsed[ungrouped.id] ?? false

            if (includeProfiles) {
                builtIn.profiles = profiles.filter(p => p.group === builtIn.id)
                profiles = profiles.filter(p => p.group !== builtIn.id)

                ungrouped.profiles = profiles
            }

            groups.push(builtIn)
            groups.push(ungrouped)
        }

        return groups
    }

    /**
    * Save ProfileGroup collapse state in localStorage
    */
    saveProfileGroupCollapse(group: PartialProfileGroup<ProfileGroup>) {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

}
