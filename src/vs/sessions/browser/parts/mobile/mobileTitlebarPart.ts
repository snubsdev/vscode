/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './mobileChatShell.css';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, disposableWindowInterval, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IAction, Separator } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { autorun } from '../../../../base/common/observable.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { fillInActionBarActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IsNewChatSessionContext } from '../../../common/contextkeys.js';
import { Menus } from '../../menus.js';
import { ChatEntitlementService, IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { getAccountTitleBarState, getAccountProfileImageUrl, getAccountTitleBarBadgeKey } from '../../../contrib/accountMenu/browser/accountTitleBarState.js';
import { ChatStatusDashboard } from '../../../../workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.js';

/**
 * Mobile titlebar — prepended above the workbench grid on phone viewports
 * in place of the desktop titlebar.
 *
 * Layout (contextual right slot):
 *
 *  - **In a chat session** → `[☰]  [session title]  [+]`
 *  - **Welcome / new session** → `[☰]  [host widget | title]  [account]`
 *
 * The center slot switches content based on whether the sessions welcome
 * (home/empty) screen is visible:
 *
 *  - **Welcome hidden** → shows the active session title (live, from
 *    {@link ISessionsManagementService.activeSession}).
 *  - **Welcome visible** → shows whatever is contributed to the
 *    {@link Menus.MobileTitleBarCenter} menu. On web, the host filter
 *    contribution appends its host dropdown + connection button there.
 *
 * The switch is driven entirely by the menu: when the toolbar has no
 * items the title is shown; as soon as it has items the title is hidden
 * and the toolbar fills the slot.
 *
 * The right slot swaps between the new-session (+) button (in a chat)
 * and the account indicator (on welcome / new session). The account
 * indicator shows the user's avatar or a person icon with an optional
 * dot badge for quota/status warnings. Tapping it opens a panel with
 * account info, copilot status dashboard, and sign-in/sign-out actions.
 */
export class MobileTitlebarPart extends Disposable {

	readonly element: HTMLElement;

	private readonly sessionTitleElement: HTMLElement;
	private readonly actionsContainer: HTMLElement;

	private readonly _onDidClickHamburger = this._register(new Emitter<void>());
	readonly onDidClickHamburger: Event<void> = this._onDidClickHamburger.event;

	private readonly _onDidClickNewSession = this._register(new Emitter<void>());
	readonly onDidClickNewSession: Event<void> = this._onDidClickNewSession.event;

	private readonly _onDidClickTitle = this._register(new Emitter<void>());
	readonly onDidClickTitle: Event<void> = this._onDidClickTitle.event;

	// Account indicator state
	private readonly accountButton: HTMLElement;
	private readonly accountAvatarElement: HTMLImageElement;
	private readonly accountIconElement: HTMLElement;
	private readonly accountBadgeElement: HTMLElement;
	private accountName: string | undefined;
	private accountProviderId: string | undefined;
	private accountProviderLabel: string | undefined;
	private isAccountLoading = true;
	private accountRequestCounter = 0;
	private avatarRequestCounter = 0;
	private currentAvatarUrl: string | undefined;
	private loadedAvatarUrl: string | undefined;
	private isAccountMenuVisible = false;
	private lastBadgeKey: string | undefined;
	private dismissedBadgeKey: string | undefined;
	private readonly accountPanelDisposable = this._register(new MutableDisposable<DisposableStore>());
	private readonly avatarLoadDisposable = this._register(new MutableDisposable());
	private readonly copilotDashboardStore = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		parent: HTMLElement,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IChatEntitlementService private readonly chatEntitlementService: ChatEntitlementService,
		@IMenuService private readonly menuService: IMenuService,
	) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'mobile-top-bar';

		// Register DOM removal before appending so that any exception
		// between this point and the end of the constructor still cleans
		// up the element via disposal.
		this._register(toDisposable(() => this.element.remove()));
		parent.prepend(this.element);

		// Hamburger button
		const hamburger = append(this.element, $('button.mobile-top-bar-button'));
		hamburger.setAttribute('aria-label', localize('mobileTopBar.openSessions', "Open sessions"));
		const hamburgerIcon = append(hamburger, $('span'));
		hamburgerIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.menu));
		this._register(addDisposableListener(hamburger, EventType.CLICK, () => this._onDidClickHamburger.fire()));

		// Center slot: title and/or actions container (mutually exclusive)
		const center = append(this.element, $('div.mobile-top-bar-center'));

		this.sessionTitleElement = append(center, $('button.mobile-session-title'));
		this.sessionTitleElement.setAttribute('type', 'button');
		this.sessionTitleElement.textContent = localize('mobileTopBar.newSession', "New Session");
		this._register(addDisposableListener(this.sessionTitleElement, EventType.CLICK, () => this._onDidClickTitle.fire()));

		this.actionsContainer = append(center, $('div.mobile-top-bar-actions'));

		// New session button (+) — shown when in a chat, hidden on welcome
		const newSessionButton = append(this.element, $('button.mobile-top-bar-button.mobile-new-session-button'));
		newSessionButton.setAttribute('aria-label', localize('mobileTopBar.newSessionAria', "New session"));
		const newSessionIcon = append(newSessionButton, $('span'));
		newSessionIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.plus));
		this._register(addDisposableListener(newSessionButton, EventType.CLICK, () => this._onDidClickNewSession.fire()));

		// Account indicator — shown on welcome/new session, hidden in a chat
		this.accountButton = append(this.element, $('button.mobile-top-bar-button.mobile-account-indicator'));
		this.accountButton.setAttribute('aria-label', localize('mobileTopBar.account', "Account"));
		this.accountAvatarElement = append(this.accountButton, $('img.mobile-account-avatar', { alt: '', draggable: 'false' })) as HTMLImageElement;
		this.accountAvatarElement.decoding = 'async';
		this.accountAvatarElement.referrerPolicy = 'no-referrer';
		this.accountIconElement = append(this.accountButton, $('span'));
		this.accountBadgeElement = append(this.accountButton, $('span.mobile-account-badge'));
		this._register(addDisposableListener(this.accountButton, EventType.CLICK, () => this.showAccountPanel()));

		// Track account state
		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => this.refreshAccount()));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => this.renderAccountState()));
		this._register(this.chatEntitlementService.onDidChangeSentiment(() => this.renderAccountState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaExceeded(() => this.renderAccountState()));
		this._register(this.chatEntitlementService.onDidChangeQuotaRemaining(() => this.renderAccountState()));
		this.refreshAccount();

		// Keep the title in sync with the active session
		this._register(autorun(reader => {
			const session = this.sessionsManagementService.activeSession.read(reader);
			const title = session?.title.read(reader);
			this.sessionTitleElement.textContent = title || localize('mobileTopBar.newSession', "New Session");
		}));

		// Mount the center toolbar (host filter widget on web welcome, etc.)
		const toolbar = this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.actionsContainer, Menus.MobileTitleBarCenter, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			telemetrySource: 'mobileTitlebar.center',
			toolbarOptions: { primaryGroup: () => true },
		}));

		// Switch between title and toolbar based on whether a new (empty)
		// chat session is active AND whether the toolbar has anything to
		// show. The latter is important because on desktop/electron or
		// when no agent hosts are configured the toolbar can be empty —
		// in that case we keep the title visible.
		const newChatKeySet = new Set([IsNewChatSessionContext.key]);
		const updateCenterMode = () => {
			const isNewChat = !!IsNewChatSessionContext.getValue(contextKeyService);
			const hasActions = toolbar.getItemsLength() > 0;
			this.element.classList.toggle('show-actions', isNewChat && hasActions);

			// Right slot: swap between [+] (in-chat) and [account] (welcome)
			newSessionButton.style.display = isNewChat ? 'none' : '';
			this.accountButton.style.display = isNewChat ? '' : 'none';
		};
		updateCenterMode();
		this._register(contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(newChatKeySet)) {
				updateCenterMode();
			}
		}));
		this._register(toolbar.onDidChangeMenuItems(() => updateCenterMode()));
	}

	/**
	 * Explicitly set the title shown in the center slot. Called only when
	 * overriding the live session title (tests, placeholders). The live
	 * subscription will overwrite this on the next session change.
	 */
	setTitle(title: string): void {
		this.sessionTitleElement.textContent = title;
	}

	// --- Account Indicator --- //

	private async refreshAccount(): Promise<void> {
		const requestId = ++this.accountRequestCounter;
		this.isAccountLoading = true;
		this.renderAccountState();

		const account = await this.defaultAccountService.getDefaultAccount();
		if (requestId !== this.accountRequestCounter) {
			return;
		}

		this.accountName = account?.accountName;
		this.accountProviderId = account?.authenticationProvider.id;
		this.accountProviderLabel = account?.authenticationProvider.name;
		this.isAccountLoading = false;
		this.refreshAvatar();
		this.renderAccountState();
	}

	private renderAccountState(): void {
		const state = getAccountTitleBarState({
			isAccountLoading: this.isAccountLoading,
			accountName: this.accountName,
			accountProviderLabel: this.accountProviderLabel,
			entitlement: this.chatEntitlementService.entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
		});

		// Avatar
		const hasAvatar = !!this.loadedAvatarUrl && !this.isAccountLoading;
		this.accountAvatarElement.classList.toggle('visible', hasAvatar);
		if (hasAvatar && this.accountAvatarElement.src !== this.loadedAvatarUrl) {
			this.accountAvatarElement.src = this.loadedAvatarUrl!;
		} else if (!hasAvatar) {
			this.accountAvatarElement.removeAttribute('src');
		}

		// Codicon fallback
		const titleBarIcon = state.dotBadge ? Codicon.account : state.icon;
		this.accountIconElement.className = ThemeIcon.asClassName(titleBarIcon);
		this.accountIconElement.classList.toggle('hidden', hasAvatar);

		// Dot badge
		const badgeKey = getAccountTitleBarBadgeKey(state);
		if (badgeKey !== this.lastBadgeKey) {
			this.lastBadgeKey = badgeKey;
			this.dismissedBadgeKey = undefined;
		}
		const showBadge = !!badgeKey && badgeKey !== this.dismissedBadgeKey;
		this.accountBadgeElement.style.display = showBadge ? '' : 'none';
		this.accountBadgeElement.classList.toggle('dot-badge-warning', showBadge && state.dotBadge === 'warning');
		this.accountBadgeElement.classList.toggle('dot-badge-error', showBadge && state.dotBadge === 'error');

		// ARIA
		this.accountButton.setAttribute('aria-label', state.ariaLabel);
	}

	private refreshAvatar(): void {
		const avatarUrl = getAccountProfileImageUrl(this.accountProviderId, this.accountName);
		if (avatarUrl === this.currentAvatarUrl) {
			return;
		}

		this.currentAvatarUrl = avatarUrl;
		this.loadedAvatarUrl = undefined;
		this.avatarLoadDisposable.clear();
		const requestId = ++this.avatarRequestCounter;

		if (!avatarUrl) {
			this.renderAccountState();
			return;
		}

		const image = new Image();
		image.referrerPolicy = 'no-referrer';
		const clearHandlers = () => { image.onload = null; image.onerror = null; };
		image.onload = () => {
			if (requestId !== this.avatarRequestCounter) { return; }
			this.loadedAvatarUrl = avatarUrl;
			this.renderAccountState();
			clearHandlers();
		};
		image.onerror = () => {
			if (requestId !== this.avatarRequestCounter) { return; }
			this.loadedAvatarUrl = undefined;
			this.renderAccountState();
			clearHandlers();
		};
		this.avatarLoadDisposable.value = toDisposable(() => { clearHandlers(); image.src = ''; });
		image.src = avatarUrl;
	}

	// --- Account Panel --- //

	private showAccountPanel(): void {
		if (this.isAccountMenuVisible) {
			this.accountPanelDisposable.clear();
			return;
		}

		this.accountPanelDisposable.clear();

		const panelStore = new DisposableStore();
		this.accountPanelDisposable.value = panelStore;

		const currentState = getAccountTitleBarState({
			isAccountLoading: this.isAccountLoading,
			accountName: this.accountName,
			accountProviderLabel: this.accountProviderLabel,
			entitlement: this.chatEntitlementService.entitlement,
			sentiment: this.chatEntitlementService.sentiment,
			quotas: this.chatEntitlementService.quotas,
		});
		const badgeKey = getAccountTitleBarBadgeKey(currentState);
		if (badgeKey) {
			this.dismissedBadgeKey = badgeKey;
		}

		this.isAccountMenuVisible = true;
		this.renderAccountState();
		panelStore.add({
			dispose: () => {
				this.isAccountMenuVisible = false;
				this.renderAccountState();
			}
		});

		// Backdrop — covers the screen behind the panel to catch taps outside
		const backdrop = append(this.element.ownerDocument.body, $('div.mobile-account-panel-backdrop'));
		panelStore.add(toDisposable(() => backdrop.remove()));
		panelStore.add(addDisposableListener(backdrop, EventType.CLICK, () => {
			this.accountPanelDisposable.clear();
		}));

		// Panel — positioned below the top bar, right-aligned
		const panelContent = this.createPanelContent(panelStore);
		panelContent.classList.add('mobile-account-panel-dropdown');
		append(backdrop, panelContent);
	}

	private createPanelContent(panelStore: DisposableStore): HTMLElement {
		const panel = $('div.sessions-account-titlebar-panel');

		// Header
		const headerSection = append(panel, $('.sessions-account-titlebar-panel-header'));
		const title = append(headerSection, $('div.sessions-account-titlebar-panel-title'));
		title.textContent = this.accountName
			? localize('signedInAsHeader', "Signed in as {0}", this.accountName)
			: this.isAccountLoading
				? localize('loadingAccountHeader', "Loading Account...")
				: localize('accountMenuHeaderFallback', "Account");

		// Header action buttons (settings, sign-out)
		const headerActions = this.getHeaderActions();
		if (headerActions.length > 0) {
			const headerActionsContainer = append(headerSection, $('.sessions-account-titlebar-panel-header-actions'));
			for (const action of headerActions) {
				const button = append(headerActionsContainer, $('button.sessions-account-titlebar-panel-header-action', { type: 'button' })) as HTMLButtonElement;
				button.disabled = !action.enabled;
				button.setAttribute('aria-label', action.tooltip || action.label);
				button.title = action.tooltip || action.label;
				button.classList.add(...ThemeIcon.asClassNameArray(this.getHeaderActionIcon(action)));
				panelStore.add(addDisposableListener(button, EventType.CLICK, async event => {
					event.preventDefault();
					event.stopPropagation();
					this.accountPanelDisposable.clear();
					await Promise.resolve(action.run());
				}));
			}
		}

		// Menu actions
		const actions = this.getPanelActions();
		if (actions.length > 0) {
			const actionsSection = append(panel, $('.sessions-account-titlebar-panel-actions'));
			let lastWasSeparator = true;
			for (const action of actions) {
				if (action instanceof Separator) {
					if (!lastWasSeparator) {
						append(actionsSection, $('.sessions-account-titlebar-panel-separator'));
						lastWasSeparator = true;
					}
					continue;
				}
				lastWasSeparator = false;
				const button = append(actionsSection, $('button.sessions-account-titlebar-panel-action', { type: 'button' })) as HTMLButtonElement;
				button.disabled = !action.enabled;
				button.setAttribute('aria-label', action.tooltip || action.label);
				button.classList.toggle('checked', !!action.checked);
				append(button, ...renderLabelWithIcons(action.label));
				panelStore.add(addDisposableListener(button, EventType.CLICK, async event => {
					event.preventDefault();
					event.stopPropagation();
					this.accountPanelDisposable.clear();
					await Promise.resolve(action.run());
				}));
			}
		}

		// Content: copilot dashboard or summary
		const contentSection = append(panel, $('.sessions-account-titlebar-panel-content'));
		if (!this.chatEntitlementService.sentiment.hidden && !!this.accountName) {
			const store = new DisposableStore();
			this.copilotDashboardStore.value = store;
			const dashboardElement = ChatStatusDashboard.instantiateInContents(this.instantiationService, store, {
				disableInlineSuggestionsSettings: true,
				disableModelSelection: true,
				disableProviderOptions: true,
				disableCompletionsSnooze: true,
			});
			store.add(disposableWindowInterval(mainWindow, () => {
				if (!dashboardElement.isConnected) {
					store.dispose();
				}
			}, 2000));
			append(contentSection, dashboardElement);
		} else if (!this.isAccountLoading) {
			const currentState = getAccountTitleBarState({
				isAccountLoading: this.isAccountLoading,
				accountName: this.accountName,
				accountProviderLabel: this.accountProviderLabel,
				entitlement: this.chatEntitlementService.entitlement,
				sentiment: this.chatEntitlementService.sentiment,
				quotas: this.chatEntitlementService.quotas,
			});
			const summary = append(contentSection, $('.sessions-account-titlebar-panel-summary'));
			summary.textContent = currentState.ariaLabel;
		}

		return panel;
	}

	private getHeaderActions(): IAction[] {
		const menu = this.menuService.createMenu(Menus.AccountMenu, this.contextKeyService);
		const rawActions: IAction[] = [];
		fillInActionBarActions(menu.getActions(), rawActions);
		menu.dispose();
		const settingsAction = rawActions.find(a => !(a instanceof Separator) && a.id === 'workbench.action.openSettings');
		const signOutAction = rawActions.find(a => !(a instanceof Separator) && a.id === 'workbench.action.agenticSignOut');
		return [settingsAction, signOutAction].filter((a): a is IAction => !!a);
	}

	private getPanelActions(): IAction[] {
		const menu = this.menuService.createMenu(Menus.AccountMenu, this.contextKeyService);
		const rawActions: IAction[] = [];
		fillInActionBarActions(menu.getActions(), rawActions);
		menu.dispose();
		return rawActions.filter(action => {
			if (action instanceof Separator) {
				return true;
			}
			if (this.isAccountLoading && action.id === 'workbench.action.agenticSignIn') {
				return false;
			}
			return action.id !== 'workbench.action.agenticSignOut'
				&& action.id !== 'workbench.action.openSettings'
				&& !action.id.startsWith('update.');
		});
	}

	private getHeaderActionIcon(action: IAction): ThemeIcon {
		switch (action.id) {
			case 'workbench.action.openSettings': return Codicon.settingsGear;
			case 'workbench.action.agenticSignOut': return Codicon.signOut;
			default: return Codicon.circleLargeFilled;
		}
	}
}
