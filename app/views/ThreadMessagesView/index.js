import React from 'react';
import PropTypes from 'prop-types';
import {
	FlatList, View, Text, InteractionManager
} from 'react-native';
import { connect } from 'react-redux';
import { Q } from '@nozbe/watermelondb';
import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';

import styles from './styles';
import Item from './Item';
import ActivityIndicator from '../../containers/ActivityIndicator';
import I18n from '../../i18n';
import RocketChat from '../../lib/rocketchat';
import database from '../../lib/database';
import StatusBar from '../../containers/StatusBar';
import buildMessage from '../../lib/methods/helpers/buildMessage';
import log from '../../utils/log';
import debounce from '../../utils/debounce';
import protectedFunction from '../../lib/methods/helpers/protectedFunction';
import { themes } from '../../constants/colors';
import { withTheme } from '../../theme';
import { getUserSelector } from '../../selectors/login';
import SafeAreaView from '../../containers/SafeAreaView';
import * as HeaderButton from '../../containers/HeaderButton';
import Separator from '../../containers/Separator';
import FilterItem from './FilterItem';
import FilterDropdown from './FilterDropdown';

const API_FETCH_COUNT = 50;

class ThreadMessagesView extends React.Component {
	static navigationOptions = ({ navigation, isMasterDetail }) => {
		const options = {
			title: I18n.t('Threads')
		};
		if (isMasterDetail) {
			options.headerLeft = () => <HeaderButton.CloseModal navigation={navigation} />;
		}
		return options;
	}

	static propTypes = {
		user: PropTypes.object,
		navigation: PropTypes.object,
		route: PropTypes.object,
		baseUrl: PropTypes.string,
		useRealName: PropTypes.bool,
		theme: PropTypes.string,
		isMasterDetail: PropTypes.bool
	}

	constructor(props) {
		super(props);
		this.mounted = false;
		this.rid = props.route.params?.rid;
		this.t = props.route.params?.t;
		this.state = {
			loading: false,
			end: false,
			messages: [],
			subscription: {},
			showFilterDropdown: false
		};
		this.subscribeData();
	}

	componentDidMount() {
		this.mounted = true;
		this.mountInteraction = InteractionManager.runAfterInteractions(() => {
			this.init();
		});
	}

	componentWillUnmount() {
		console.countReset(`${ this.constructor.name }.render calls`);
		if (this.mountInteraction && this.mountInteraction.cancel) {
			this.mountInteraction.cancel();
		}
		if (this.syncInteraction && this.syncInteraction.cancel) {
			this.syncInteraction.cancel();
		}
		if (this.subSubscription && this.subSubscription.unsubscribe) {
			this.subSubscription.unsubscribe();
		}
		if (this.messagesSubscription && this.messagesSubscription.unsubscribe) {
			this.messagesSubscription.unsubscribe();
		}
	}

	// eslint-disable-next-line react/sort-comp
	subscribeData = async() => {
		try {
			const db = database.active;
			const subscription = await db.collections
				.get('subscriptions')
				.find(this.rid);
			const observable = subscription.observe();
			this.subSubscription = observable
				.subscribe((data) => {
					this.setState({ subscription: data });
				});
			this.messagesObservable = db.collections
				.get('threads')
				.query(
					Q.where('rid', this.rid),
					Q.experimentalSortBy('tlm', Q.desc)
				)
				.observeWithColumns(['updated_at']);
			this.messagesSubscription = this.messagesObservable
				.subscribe((messages) => {
					if (this.mounted) {
						this.setState({ messages });
					} else {
						this.state.messages = messages;
					}
				});
		} catch (e) {
			// Do nothing
		}
	}

	// eslint-disable-next-line react/sort-comp
	init = () => {
		const { subscription } = this.state;
		if (!subscription) {
			return this.load();
		}
		try {
			const lastThreadSync = new Date();
			if (subscription.lastThreadSync) {
				this.sync(subscription.lastThreadSync);
			} else {
				this.load(lastThreadSync);
			}
		} catch (e) {
			log(e);
		}
	}

	updateThreads = async({ update, remove, lastThreadSync }) => {
		const { subscription } = this.state;
		// if there's no subscription, manage data on this.state.messages
		// note: sync will never be called without subscription
		if (!subscription) {
			this.setState(({ messages }) => ({ messages: [...messages, ...update] }));
			return;
		}

		try {
			const db = database.active;
			const threadsCollection = db.collections.get('threads');
			const allThreadsRecords = await subscription.threads.fetch();
			let threadsToCreate = [];
			let threadsToUpdate = [];
			let threadsToDelete = [];

			if (update && update.length) {
				update = update.map(m => buildMessage(m));
				// filter threads
				threadsToCreate = update.filter(i1 => !allThreadsRecords.find(i2 => i1._id === i2.id));
				threadsToUpdate = allThreadsRecords.filter(i1 => update.find(i2 => i1.id === i2._id));
				threadsToCreate = threadsToCreate.map(thread => threadsCollection.prepareCreate(protectedFunction((t) => {
					t._raw = sanitizedRaw({ id: thread._id }, threadsCollection.schema);
					t.subscription.set(subscription);
					Object.assign(t, thread);
				})));
				threadsToUpdate = threadsToUpdate.map((thread) => {
					const newThread = update.find(t => t._id === thread.id);
					return thread.prepareUpdate(protectedFunction((t) => {
						Object.assign(t, newThread);
					}));
				});
			}

			if (remove && remove.length) {
				threadsToDelete = allThreadsRecords.filter(i1 => remove.find(i2 => i1.id === i2._id));
				threadsToDelete = threadsToDelete.map(t => t.prepareDestroyPermanently());
			}

			await db.action(async() => {
				await db.batch(
					...threadsToCreate,
					...threadsToUpdate,
					...threadsToDelete,
					subscription.prepareUpdate((s) => {
						s.lastThreadSync = lastThreadSync;
					})
				);
			});
		} catch (e) {
			log(e);
		}
	}

	// eslint-disable-next-line react/sort-comp
	load = debounce(async(lastThreadSync) => {
		const { loading, end, messages } = this.state;
		if (end || loading || !this.mounted) {
			return;
		}

		this.setState({ loading: true });

		try {
			const result = await RocketChat.getThreadsList({
				rid: this.rid, count: API_FETCH_COUNT, offset: messages.length
			});
			if (result.success) {
				this.updateThreads({ update: result.threads, lastThreadSync });
				this.setState({
					loading: false,
					end: result.count < API_FETCH_COUNT
				});
			}
		} catch (e) {
			log(e);
			this.setState({ loading: false, end: true });
		}
	}, 300)

	// eslint-disable-next-line react/sort-comp
	sync = async(updatedSince) => {
		this.setState({ loading: true });

		try {
			const result = await RocketChat.getSyncThreadsList({
				rid: this.rid, updatedSince: updatedSince.toISOString()
			});
			if (result.success && result.threads) {
				this.syncInteraction = InteractionManager.runAfterInteractions(() => {
					const { update, remove } = result.threads;
					this.updateThreads({ update, remove, lastThreadSync: updatedSince });
				});
			}
			this.setState({
				loading: false
			});
		} catch (e) {
			log(e);
			this.setState({ loading: false });
		}
	}

	onThreadPress = debounce((item) => {
		const { navigation, isMasterDetail } = this.props;
		if (isMasterDetail) {
			navigation.pop();
		}
		navigation.push('RoomView', {
			rid: item.subscription.id, tmid: item.id, name: item.msg, t: 'thread'
		});
	}, 1000, true)

	renderEmpty = () => {
		const { theme } = this.props;
		return (
			<View style={[styles.listEmptyContainer, { backgroundColor: themes[theme].backgroundColor }]} testID='thread-messages-view'>
				<Text style={[styles.noDataFound, { color: themes[theme].titleText }]}>{I18n.t('No_thread_messages')}</Text>
			</View>
		);
	}

	getBadgeColor = (item) => {
		const { subscription } = this.state;
		const { theme } = this.props;
		if (subscription?.tunreadUser?.includes(item?.id)) {
			return themes[theme].mentionMeBackground;
		}
		if (subscription?.tunreadGroup?.includes(item?.id)) {
			return themes[theme].mentionGroupBackground;
		}
		if (subscription?.tunread?.includes(item?.id)) {
			return themes[theme].tunreadBackground;
		}
	}

	showFilterDropdown = () => this.setState({ showFilterDropdown: true })

	closeFilterDropdown = () => this.setState({ showFilterDropdown: false })

	renderItem = ({ item }) => {
		const {
			user, navigation, baseUrl, useRealName
		} = this.props;
		const badgeColor = this.getBadgeColor(item);
		return (
			<Item
				{...{
					item,
					user,
					navigation,
					baseUrl,
					useRealName,
					badgeColor
				}}
				onPress={this.onThreadPress}
			/>
		);
	}

	renderHeader = () => {
		const { messages } = this.state;
		if (!messages.length) {
			return null;
		}

		return (
			<>
				<FilterItem onPress={this.showFilterDropdown} text='Displaying Following' iconName='filter' showBorder />
				<Separator />
			</>
		);
	}

	render() {
		console.count(`${ this.constructor.name }.render calls`);
		const { loading, messages, showFilterDropdown } = this.state;
		const { theme } = this.props;

		if (!loading && messages.length === 0) {
			return this.renderEmpty();
		}

		return (
			<SafeAreaView testID='thread-messages-view' theme={theme}>
				<StatusBar theme={theme} />
				<FlatList
					data={messages}
					extraData={this.state}
					renderItem={this.renderItem}
					style={[styles.list, { backgroundColor: themes[theme].backgroundColor }]}
					contentContainerStyle={styles.contentContainer}
					keyExtractor={item => item._id}
					onEndReached={this.load}
					onEndReachedThreshold={0.5}
					maxToRenderPerBatch={5}
					initialNumToRender={1}
					ItemSeparatorComponent={Separator}
					ListHeaderComponent={this.renderHeader}
					ListFooterComponent={loading ? <ActivityIndicator theme={theme} /> : null}
				/>
				{showFilterDropdown ? <FilterDropdown close={this.closeFilterDropdown} /> : null}
			</SafeAreaView>
		);
	}
}

const mapStateToProps = state => ({
	baseUrl: state.server.server,
	user: getUserSelector(state),
	useRealName: state.settings.UI_Use_Real_Name,
	isMasterDetail: state.app.isMasterDetail
});

export default connect(mapStateToProps)(withTheme(ThreadMessagesView));
