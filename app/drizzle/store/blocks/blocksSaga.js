import { END, eventChannel } from 'redux-saga';
import {
  call,
  put,
  take,
  takeEvery,
  takeLatest,
  select,
  all,
} from 'redux-saga/effects';

import { selectContractsSubscriptions } from 'drizzle/store/contracts/contractsSelectors';
import { selectAccount } from 'containers/ConnectionProvider/selectors';
import BlockTracker from 'eth-block-tracker-es5';
import { ETH_BALANCE_UPDATED } from 'containers/DrizzleProvider/constants';

/*
 * Listen for Blocks
 */

export function createBlockChannel({ drizzle, web3, syncAlways }) {
  return eventChannel((emit) => {
    const blockEvents = web3.eth
      .subscribe('newBlockHeaders', (error) => {
        if (error) {
          emit({ type: 'BLOCKS_FAILED', error });

          console.error('Error in block header subscription:');
          console.error(error);

          emit(END);
        }
      })
      .on('data', (blockHeader) => {
        emit({
          type: 'BLOCK_RECEIVED',
          blockHeader,
          drizzle,
          web3,
          syncAlways,
        });
      })
      .on('error', (error) => {
        emit({ type: 'BLOCKS_FAILED', error });
        emit(END);
      });

    const unsubscribe = () => {
      blockEvents.off();
    };

    return unsubscribe;
  });
}

function* callCreateBlockChannel({ drizzle, web3, syncAlways }) {
  const blockChannel = yield call(createBlockChannel, {
    drizzle,
    web3,
    syncAlways,
  });

  try {
    while (true) {
      const event = yield take(blockChannel);
      yield put(event);
    }
  } finally {
    blockChannel.close();
  }
}

/*
 * Poll for Blocks
 */

export function createBlockPollChannel({
  drizzle,
  interval,
  web3,
  syncAlways,
}) {
  return eventChannel((emit) => {
    const blockTracker = new BlockTracker({
      provider: web3.currentProvider,
      pollingInterval: interval,
    });

    blockTracker.on('block', (block) => {
      emit({ type: 'BLOCK_FOUND', block, drizzle, web3, syncAlways });
    });

    blockTracker.start().catch((error) => {
      emit({ type: 'BLOCKS_FAILED', error });
      emit(END);
    });

    const unsubscribe = () => {
      blockTracker.stop().catch((_) => {
        // BlockTracker assumes there is an outstanding event subscription.
        // However for our tests we start and stop a BlockTracker in succession
        // that triggers an error.
      });
    };

    return unsubscribe;
  });
}

function* callCreateBlockPollChannel({ drizzle, interval, web3, syncAlways }) {
  const blockChannel = yield call(createBlockPollChannel, {
    drizzle,
    interval,
    web3,
    syncAlways,
  });

  try {
    while (true) {
      const event = yield take(blockChannel);
      yield put(event);
    }
  } finally {
    blockChannel.close();
  }
}

/*
 * Process Blocks
 */

function* processBlockHeader({ blockHeader, drizzle, web3, syncAlways }) {
  const blockNumber = blockHeader.number;

  try {
    const block = yield call(web3.eth.getBlock, blockNumber, true);

    yield call(processBlock, { block, drizzle, web3, syncAlways });
  } catch (error) {
    console.error('Error in block processing:');
    console.error(error);

    yield put({ type: 'BLOCK_FAILED', error });
  }
}

function* processBlock({ block, drizzle, web3, syncAlways }) {
  const account = yield select(selectAccount());
  if (!account) {
    return;
  }
  const subscriptions = yield select(selectContractsSubscriptions());
  try {
    // Emit block for addition to store.
    // Regardless of syncing success/failure, this is still the latest block.
    yield put({ type: 'BLOCK_PROCESSING', block });

    if (syncAlways) {
      yield all(
        Object.keys(drizzle.contracts).map((key) =>
          put({
            type: 'CONTRACT_SYNCING',
            contract: drizzle.contracts[key],
          }),
        ),
      );

      return;
    }

    const contractsPendingSync = {};

    const transferTopic =
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const watchedTopics = [transferTopic];

    const logs = yield web3.eth.getPastLogs({
      fromBlock: block.number,
      toBlock: block.number,
      topics: watchedTopics,
    });

    const checkForTransactions = (log) => {
      const { topics, address } = log;

      const from = topics[1];
      const to = topics[2];
      if (!from || !to) {
        return;
      }
      const fromMatch = _.endsWith(
        from.toLowerCase(),
        account.replace(/0x/, ''),
      );
      const toMatch = _.endsWith(to.toLowerCase(), account.replace(/0x/, ''));
      const transactionAffectsUser = fromMatch || toMatch;
      if (transactionAffectsUser) {
        const contract = drizzle.findContractByAddress(address.toLowerCase());
        const checksumAddress = web3.utils.toChecksumAddress(address);
        contractsPendingSync[checksumAddress] = contract;
      }
    };
    _.each(logs, checkForTransactions);

    const txs = block.transactions;

    if (txs.length > 0) {
      // Loop through txs looking for any contract address of interest
      for (let i = 0; i < txs.length; i += 1) {
        const from = txs[i].from || '';
        const fromContract = drizzle.findContractByAddress(from.toLowerCase());

        if (fromContract) {
          contractsPendingSync[from] = fromContract;
        }

        const to = txs[i].to || '';
        const toContract = drizzle.findContractByAddress(to.toLowerCase());
        if (toContract) {
          contractsPendingSync[to] = toContract;
        }
      }
    }
    const contractAddressesPendingSync = Object.keys(contractsPendingSync);

    const request = [];
    const buildBatchCallRequest = (subscription) => {
      const newSubscription = _.clone(subscription);
      const subscriptionAddresses = subscription.addresses;

      const matchedAddreses = _.intersection(
        subscriptionAddresses,
        contractAddressesPendingSync,
      );
      const foundMatchedAddresses = matchedAddreses.length;
      if (foundMatchedAddresses) {
        newSubscription.addresses = matchedAddreses;
        request.push(newSubscription);
      }
    };

    _.each(subscriptions, buildBatchCallRequest);
    yield put({ type: 'BATCH_CALL_REQUEST', request });
  } catch (error) {
    console.error('Error in block processing:');
    console.error(error);

    yield put({ type: 'BLOCK_FAILED', error });
  }
}

function* updateAccountEth(action) {
  yield put({ type: 'ACCOUNT_BALANCES_FETCHING' });
  const { web3 } = action;
  const account = yield select(selectAccount());
  if (!account || !web3) {
    return;
  }
  const ethBalance = yield web3.eth.getBalance(account);
  yield put({ type: ETH_BALANCE_UPDATED, ethBalance });
}

function* blocksSaga() {
  // Block Subscriptions
  yield takeLatest('BLOCKS_LISTENING', callCreateBlockChannel);
  yield takeEvery('APP_READY', updateAccountEth);
  yield takeEvery('BLOCK_RECEIVED', processBlockHeader);
  yield takeEvery('BLOCK_RECEIVED', updateAccountEth);

  // Block Polling
  yield takeLatest('BLOCKS_POLLING', callCreateBlockPollChannel);
  yield takeEvery('BLOCK_FOUND', processBlock);
}

export default blocksSaga;
