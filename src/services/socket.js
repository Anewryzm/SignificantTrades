import Vue from 'vue'
import Axios from 'axios'

import Kraken from '../exchanges/kraken'
import Bitmex from '../exchanges/bitmex'
import Coinex from '../exchanges/coinex'
import Huobi from '../exchanges/huobi'
import Binance from '../exchanges/binance'
import Bitfinex from '../exchanges/bitfinex'
import Bitstamp from '../exchanges/bitstamp'
import Gdax from '../exchanges/gdax'
import Hitbtc from '../exchanges/hitbtc'
import Okex from '../exchanges/okex'
import Poloniex from '../exchanges/poloniex'

import store from '../services/store'
import Liquid from '../exchanges/liquid';

const emitter = new Vue({
	data() {
		return {
			API_URL: null,
			API_SUPPORTED_PAIRS: null,
			PROXY_URL: null,

			exchanges: [
				new Bitmex(),
				new Bitfinex(),
				new Coinex(),
				new Binance(),
				new Gdax(),
				new Huobi(),
				new Bitstamp(),
				new Hitbtc(),
				new Okex(),
				new Poloniex(),
				new Liquid()
			],

			trades: [],
			ticks: [],
			timestamps: {},
			queue: [],

			_pair: null,
			_fetchedMax: false,
			_fetchedTime: 0,
			_fetchedBytes: 0,
			_firstCloses: {},
			_replayTime: 0
		}
	},
  computed: {
    pair() {
      return store.state.pair
    },
    timeframe() {
      return store.state.timeframe
    },
		exchangesSettings() {
			return store.state.exchanges
		},
		actives() {
			return store.state.actives
		},
    showChart() {
      return store.state.showChart
    },
    chartRange() {
      return store.state.chartRange
    },
    showCounters() {
      return store.state.showCounters
    },
    countersSteps() {
      return store.state.countersSteps
    },
		isLoading() {
			return store.state.isLoading
		},
		isReplaying() {
			return store.state.isReplaying
		}
  },
	created() {
		this._fetchedTime = this._fetchedBytes = 0;

		window.emitTrade = (exchange, price, amount, side, type = null) => {
			exchange = exchange || 'bitmex';

			if (price === null) {
				price = this.getExchangeById(exchange).price;
			}

			amount = amount || 1;
			side = side || 1;

			let trade = [exchange, +new Date(), price, amount, side ? 1 : 0, type]

			this.queue = this.queue.concat([trade]);

			this.emitFilteredTradesAndVolumeSum([trade]);
		}

		this.exchanges.forEach(exchange => {
			exchange.on('live_trades', (trades) => {
				if (!trades || !trades.length) {
					return;
				}

				this.timestamps[exchange.id] = +new Date();

				trades = trades
					.sort((a, b) => a[1] - b[1]);

				this.queue = this.queue.concat(trades);

				if (!this.isReplaying) {
					this.emitFilteredTradesAndVolumeSum(trades);
				}
			});

			exchange.on('open', event => {
				console.log(`[socket.exchange.on.open] ${exchange.id} opened`);

				this.$emit('connected', exchange.id);
			});

			exchange.on('close', event => {
				console.log(`[socket.exchange.on.close] ${exchange.id} closed`);

				this.$emit('disconnected', exchange.id);

				if (exchange.shouldBeConnected && !this.exchangesSettings[exchange.id].disabled) {
					exchange.reconnect(this.pair);
				}
			});

			exchange.on('match', pair => {
				console.log(`[socket.exchange.on.match] ${exchange.id} matched ${pair}`);
				store.commit('setExchangeMatch', {
					exchange: exchange.id,
					match: pair
				})
			});

			exchange.on('error', event => {
				console.log(`[socket.exchange.on.error] ${exchange.id} reported an error`);

				/* if (!this.errors[exchange.id]) {
					this.errors[exchange.id] = 0;
				}

				this.errors[exchange.id]++;

				this.$emit('exchange_error', exchange.id, this.errors[exchange.id]); */
			});

			store.commit('reloadExchangeState', exchange.id);
		})
	},
	methods: {
		initialize() {
			console.log(`[sockets] initializing ${this.exchanges.length} exchange(s)`);
	
			if (process.env.API_URL) {
				this.API_URL = process.env.API_URL;
				console.info(`[sockets] API_URL = ${this.API_URL}`);

				if (process.env.API_SUPPORTED_PAIRS) {
					this.API_SUPPORTED_PAIRS = process.env.API_SUPPORTED_PAIRS.map(a => a.toUpperCase());
					console.info(`[sockets] API_SUPPORTED_PAIRS = ${this.API_SUPPORTED_PAIRS}`);
				}
			}

			if (process.env.PROXY_URL) {
				this.PROXY_URL = process.env.PROXY_URL;
				console.info(`[sockets] PROXY_URL = ${this.PROXY_URL}`);
			}

			this.connectExchanges();

			setInterval(() => {
				if (this.isReplaying || !this.queue.length) {
					return;
				}

				this.trades = this.trades.concat(this.queue);

				this.emitFilteredTradesAndVolumeSum(this.queue, 'trades.queued');

				this.queue = [];
			}, 1000);
		},
		connectExchanges(pair = null) {
			this.disconnectExchanges();

			if (pair) {
				this.pair = pair.toUpperCase();
			}

			this.trades = this.queue = this.ticks = [];
			this.timestamps = {};
			this._fetchedMax = false;

			console.log(`[socket.connect] connecting to ${this.pair}`);

			this.$emit('alert', {
				id: `server_status`,
				type: 'info',
				title: `Loading`,
				message: `Fetching products...`
			});

			Promise.all(this.exchanges.map(exchange => exchange.validatePair(this.pair))).then(() => {
				let validExchanges = this.exchanges.filter(exchange => exchange.valid);

				if (!validExchanges.length) {
					this.$emit('alert', {
						id: `server_status`,
						type: 'error',
						title: `No match`,
						message: `"${pair}" did not matched with any active pairs`
					});

					return;
				}

				this.$emit('alert', {
					id: `server_status`,
					type: 'info',
					title: `Loading`,
					message: `${validExchanges.length} exchange(s) matched ${pair}`
				});

				if (this._pair !== this.pair) {
					this.$emit('pairing', this.pair, this.canFetch());

					this._pair = this.pair;
				}

				console.log(`[socket.connect] ${validExchanges.length} successfully matched with ${this.pair}`);

				validExchanges = validExchanges.filter(exchange => !this.exchangesSettings[exchange.id].disabled);
				
				this.$emit('alert', {
					id: `server_status`,
					type: 'info',
					title: `Loading`,
					message: `Subscribing to ${this.pair} on ${validExchanges.length} exchange(s)`,
					delay: 1000 * 5
				});

				console.log(`[socket.connect] batch connect to ${validExchanges.map(a => a.id).join(' / ')}`);

				validExchanges.forEach(exchange => exchange.connect());
			});
		},
		disconnectExchanges() {
			console.log(`[socket.connect] disconnect exchanges asynchronously`);

			this.exchanges.forEach(exchange => exchange.disconnect());
		},
		clean() {
			if (this.isLoading || this.isReplaying) {
				return;
			}

			let requiredTimeframe = 0;

			if (this.showChart && this.chartRange) {
				requiredTimeframe = Math.max(requiredTimeframe, this.chartRange * 2);
			}

			const minTimestamp = Math.ceil((+new Date() - requiredTimeframe) / this.timeframe) * this.timeframe;

			console.log(`[socket.clean] remove trades older than ${new Date(minTimestamp).toLocaleString()}`);

			let i;

			for (i = 0; i < this.ticks.length; i++) {
				if (this.ticks[i].timestamp >= minTimestamp) {
					break;
				}
			}

			if (i && this.ticks.length) {
				this._fetchedMax = false;
			}

			this.ticks.splice(0, i);

			for (i = 0; i < this.trades.length; i++) {
				if (this.trades[i][1] > minTimestamp) {
					break;
				}
			}

			this.trades.splice(0, i);

			this.$emit('clean', minTimestamp)
		},
		getExchangeById(id) {
			for (let exchange of this.exchanges) {
				if (exchange.id === id) {
					return exchange;
				}
			}

			return null;
		},
		emitFilteredTradesAndVolumeSum(trades, event = 'trades.instant') {
			let upVolume = 0;
			let downVolume = 0;

			const output = trades.filter(a => {
				if (this.actives.indexOf(a[0]) === -1) {
					return false;
				}

				if (a[4] > 0) {
					upVolume += a[3];
				} else {
					downVolume += a[3];
				}

				return true;
			})

			this.$emit(event, output, upVolume, downVolume);
		},
		canFetch() {
			return this.API_URL && (!this.API_SUPPORTED_PAIRS || this.API_SUPPORTED_PAIRS.indexOf(this.pair) !== -1);
		},
		getApiUrl(from, to) {
			let url = this.API_URL;

			url = url.replace(/\{from\}/, from);
			url = url.replace(/\{to\}/, to);
			url = url.replace(/\{timeframe\}/, this.timeframe);
			url = url.replace(/\{pair\}/, this.pair.toLowerCase());
			url = url.replace(/\{exchanges\}/, this.actives.join('+'));

			return url;
		},
		fetchRangeIfNeeded(range, clear = false) {
			if (clear) {
				this.ticks.splice(0, this.ticks.length);
				this._fetchedMax = false;
			}
			
			if (this.isReplaying || !this.canFetch()) {
				return Promise.resolve(null);
			}

			const now = +new Date();

			const minData = Math.min(
				this.trades.length ? this.trades[0][1] : now,
				this.ticks.length ? this.ticks[0].timestamp : now
			);

      let promise;
			let from = now - range;
			let to = minData;

			from = Math.ceil(from / this.timeframe) * this.timeframe;
			to = Math.ceil(to / this.timeframe) * this.timeframe;

			console.log(`[socket.fetchRangeIfNeeded] minData: ${new Date(minData).toLocaleString()}, from: ${new Date(from).toLocaleString()}, to: ${to}`, this._fetchedMax ? '(FETCHED MAX)' : '');

      if (!this._fetchedMax && to - from >= 60000 && from < minData) {
				console.info(`[socket.fetchRangeIfNeeded]`, `FETCH NEEDED\n\n\tcurrent time: ${new Date(now).toLocaleString()}\n\tfrom: ${new Date(from).toLocaleString()}\n\tto: ${new Date(to).toLocaleString()} (${this.trades.length ? 'using first trade as base' : 'using now for reference'})`);

        promise = this.fetchHistoricalData(from, to);
      } else {
        promise = Promise.resolve();
      }

			return promise;
		},
		replay(speed) {
			if (this.isReplaying || this.isLoading) {
				return;
			}

			const trades = this.trades.splice(0, this.trades.length);
			const start = this._replayTime = +trades[0][1] + this.timeframe;

			console.log('BASE REPLAY TRADE', new Date(start).toLocaleString());

			let backup = [];
			let queue = [];
			let queuedAt = 0;
			let startedAt;

			const step = (timestamp) => {
				if (!startedAt) {
					startedAt = timestamp;
				}

				timestamp -= startedAt;

				if (!this.isReplaying) {
					if (trades.length) {
						backup = backup.concat(trades);
					}

					this.trades = backup.concat(this.trades);

					store.commit('toggleReplaying', false);

					return false;
				}

				this._replayTime = start + timestamp * speed;

				let index;

				for (index = 0; index < trades.length; index++) {
					if (trades[index][1] > this._replayTime) {
						break;
					}
				}

				if (index) {
					const chunk = trades.splice(0, index);

					this.emitFilteredTradesAndVolumeSum(chunk);

					queue = queue.concat(chunk);

					if (timestamp - queuedAt > 200) {
						queuedAt = timestamp;

						this.emitFilteredTradesAndVolumeSum(queue.splice(0, queue.length), 'trades.queued');
					}

					backup = backup.concat(chunk);
				}

				if (trades.length) {
					window.requestAnimationFrame(step);

				} else {
					this.trades = backup.concat(this.trades);

					store.commit('toggleReplaying', false);
				}
			}

			store.commit('toggleReplaying', {
				timestamp: start,
				speed: speed
			});

			window.requestAnimationFrame(step);
		},
		fetchHistoricalData(from, to) {
			if (
				this.isLoading 
				|| this.isReplaying 
				|| !this.canFetch()
				|| !from 
				|| !to 
			) {
				if (this.isLoading) {
					this.$emit('alert', {
						id: `already_fetching`,
						type: 'info',
						title: `Enhance your calm`
					});
				}

				return Promise.resolve();
			}

			const url = this.getApiUrl(from, to);

			if (this.lastFetchUrl === url) {
				return Promise.resolve();
			}

			this.lastFetchUrl = url;
			
			store.commit('toggleLoading', true);

			this.$emit('fetchStart', to - from);

			return new Promise((resolve, reject) => {
				Axios.get(url, {
					onDownloadProgress: e => {
						this.$emit('fetchProgress', {
							loaded: e.loaded,
							total: e.total,
							progress: e.loaded / e.total
						});
						
						this._fetchedBytes += e.loaded;
					}
				})
					.then(response => {
						if (!response.data || !response.data.format || !response.data.results.length) {
							return resolve();
						}

						const format = response.data.format;
						const results = response.data.results;

						switch (format) {
							case 'trade':
								results.map(a => {
									a[1] = +a[1];
									a[2] = +a[2];
									a[3] = +a[3];
									a[4] = +a[4];

									return a;
								});

								if (!this.trades.length) {
									console.log(`[socket.fetch] set socket.trades (${results.length} trades)`);

									this.trades = results;
								} else {
									const prepend = results.filter(trade => trade[1] <= this.trades[0][1]);
									const append = results.filter(trade => trade[1] >= this.trades[this.trades.length - 1][1]);

									if (prepend.length) {
										console.log(`[fetch] prepend ${prepend.length} ticks`);
										this.trades = prepend.concat(this.trades);
									}

									if (append.length) {
										console.log(`[fetch] append ${append.length} ticks`);
										this.trades = this.trades.concat(append);
									}
								}
							break;
							case 'tick':
								this.ticks = results;

								if (results[0].timestamp > from) {
									console.log('[socket.fetch] fetched max');
									this._fetchedMax = true;
								}
							break;
						}

						this.$emit('historical', results, format, from, to);

						resolve({
							format: format,
							results: results,
							from: from,
							to: to
						});
					})
					.catch(err => {
						this._fetchedMax = true;

						err && this.$emit('alert', {
							type: 'error',
							title: `Unable to retrieve history`,
							message: err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message,
							id: `fetch_error`
						});

						reject();
					})
					.then(() => {
						this._fetchedTime += (to - from);

						this.$emit('fetchEnd', to - from);

						store.commit('toggleLoading', false);
					})
			});
		},
		commitQueueAndRefreshListeners() {
			if (this.queue.length) {
				this.trades = this.trades.concat(this.queue);

				this.queue = [];
			}

			store.commit('setTimeframe', this.timeframe);
		},
		getTime() {
			if (this.isReplaying && this.replayTime) {
				return this.replayTime;
			}

			return +new Date();
		},
		getFirstCloses() {
			if (!this.ticks.length && !this.trades.length) {
				return this._firstCloses;
			}

			const closesByExchanges = this.exchanges.reduce((obj, exchange) => {
				obj[exchange.id] = null
				
				return obj
			}, {});

			if (!Object.keys(closesByExchanges).length) {
				return closesByExchanges;
			}

			let gotAllCloses = false;

			for (let tick of this.ticks) {
				if (typeof closesByExchanges[tick.exchange] === 'undefined' || closesByExchanges[tick.exchange]) {
					continue;
				}

				closesByExchanges[trade[0]] = trade[2];

				if (gotAllCloses || !Object.keys(closesByExchanges).map(id => closesByExchanges[id]).filter(close => close === null).length) {					
					gotAllCloses = true;
					
					break;
				}
			}

			for (let trade of this.trades) {
				if (typeof closesByExchanges[trade[0]] === 'undefined' || closesByExchanges[trade[0]]) {
					continue;
				}

				closesByExchanges[trade[0]] = trade[2];

				if (gotAllCloses || !Object.keys(closesByExchanges).map(id => closesByExchanges[id]).filter(close => close === null).length) {					
					gotAllCloses = true;

					break;
				}
			}

			for (let exchange in closesByExchanges) {
				if (closesByExchanges[exchange] === null) {
					delete closesByExchanges[exchange];
				}
			}

			this._firstCloses = closesByExchanges;

			return closesByExchanges;
		}
	}
});

export default emitter;