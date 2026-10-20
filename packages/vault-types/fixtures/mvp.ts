// Seed dataset equal to the approved prototype (docs/ui/orbit/data-mvp.js): mainnet, float cap $20.00,
// org limit $5.00, 6 agents, 1 merchant, 55 outcomes, 2 pending. Fixed, then checked by checkSnapshot().
import type { DashboardState, OutcomeItem } from "../src/api";

export const MVP_STATE: DashboardState = {
  "network": "mainnet",
  "vault_account": "orbit-vault.orbit-team.near",
  "guardian_pk": "ed25519:uKBc62EHU6EcqGUCE2UoTLWpdbpJv8dtgQVdtasY44qK",
  "snapshot": {
    "block_height": 214806331,
    "timestamp_ms": 1794493926000,
    "day": 20769,
    "fetched_at_ms": 1794493926900,
    "age_ms": 4000,
    "stale": false,
    "rpc_ok": true,
    "last_error": null
  },
  "sync": {
    "last_seq": 54,
    "gap": false,
    "gaps": [],
    "counts_match": true,
    "db_counts": {
      "paid": 43,
      "failed": 1,
      "rejected": 11
    }
  },
  "vault": {
    "version": "1.0.0",
    "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "float_cap": "20000000",
    "available": "14730000",
    "reserved": "70000",
    "deposited_total": "20000000",
    "withdrawn_total": "0",
    "paid_total": "5200000",
    "near": {
      "balance_yocto": "9800000000000000000000000",
      "storage_usage": 412000,
      "free_yocto": "5680000000000000000000000"
    }
  },
  "org": {
    "daily_limit": "5000000",
    "spent_today": "2310000",
    "reserved": "70000",
    "remaining_today": "2620000",
    "paused": false
  },
  "counts": {
    "paid": 43,
    "failed": 1,
    "rejected": 11,
    "next_seq": 55
  },
  "agents": [
    {
      "id": 1,
      "name": "crawler-v0",
      "pk": "ed25519:FM799EMzYfmdLuCFuAxpJCXCy2dUzE3wiZG4USzovJQF",
      "status": "revoked",
      "per_payment_limit": "100000",
      "daily_limit": "1000000",
      "spent_today": "0",
      "reserved": "0",
      "remaining_today": "0",
      "paid_count": 4,
      "rejected_count": 0,
      "failed_count": 0,
      "last_paid_ms": 1794390681300
    },
    {
      "id": 2,
      "name": "research-scout",
      "pk": "ed25519:t8HP4Tr8YGskci1juRRpmACfFc82CSbW8ZsYruneAk7g",
      "status": "active",
      "per_payment_limit": "250000",
      "daily_limit": "4000000",
      "spent_today": "800000",
      "reserved": "50000",
      "remaining_today": "2620000",
      "paid_count": 20,
      "rejected_count": 1,
      "failed_count": 0,
      "last_paid_ms": 1794493308300
    },
    {
      "id": 3,
      "name": "price-watcher",
      "pk": "ed25519:zAmUjHyfoRKuwjZeDDJwwxDfy9CRsf32Nok3Lc6jAAyh",
      "status": "active",
      "per_payment_limit": "100000",
      "daily_limit": "600000",
      "spent_today": "600000",
      "reserved": "0",
      "remaining_today": "0",
      "paid_count": 12,
      "rejected_count": 2,
      "failed_count": 0,
      "last_paid_ms": 1794490203300
    },
    {
      "id": 4,
      "name": "summary-writer",
      "pk": "ed25519:eV5v3jyfjTTUdTRHFfyKXXFm6McdnEA2ZjD4RMy8ANSZ",
      "status": "active",
      "per_payment_limit": "250000",
      "daily_limit": "1500000",
      "spent_today": "500000",
      "reserved": "20000",
      "remaining_today": "980000",
      "paid_count": 4,
      "rejected_count": 1,
      "failed_count": 0,
      "last_paid_ms": 1794491092300
    },
    {
      "id": 5,
      "name": "invoice-bot",
      "pk": "ed25519:awzFMoRri6STQvGs2c75zKvjgWCJCAKAWZKKt5S4Wm12",
      "status": "active",
      "per_payment_limit": "500000",
      "daily_limit": "1000000",
      "spent_today": "400000",
      "reserved": "0",
      "remaining_today": "600000",
      "paid_count": 2,
      "rejected_count": 0,
      "failed_count": 1,
      "last_paid_ms": 1794485438300
    },
    {
      "id": 6,
      "name": "rogue-test",
      "pk": "ed25519:8ggvkb88812JKBtghQGET4kxYF27FEB6bDXnMHcip5M8",
      "status": "paused",
      "per_payment_limit": "50000",
      "daily_limit": "500000",
      "spent_today": "10000",
      "reserved": "0",
      "remaining_today": "0",
      "paid_count": 1,
      "rejected_count": 7,
      "failed_count": 0,
      "last_paid_ms": 1794491885300
    }
  ],
  "merchants": [
    {
      "account": "orbit-data.orbit-team.near",
      "name": "Orbit Data API"
    }
  ],
  "pending": [
    {
      "payment_id": "2ba0fba868cdc3e18ed7407f1f857a04db9928d570fcaad29f3b909b04747df6",
      "agent_id": 2,
      "merchant": "orbit-data.orbit-team.near",
      "amount": "50000",
      "reserved_at_ms": 1794493921500
    },
    {
      "payment_id": "604f850a2df02b60bc53d6632d9303d7eca12fe43f5bc7a5cff2a4778e307e29",
      "agent_id": 4,
      "merchant": "orbit-data.orbit-team.near",
      "amount": "20000",
      "reserved_at_ms": 1794493922400
    }
  ],
  "pending_count": 2
};

export const MVP_OUTCOMES: OutcomeItem[] = [
  {"seq":0,"kind":"paid","agent_id":3,"payment_id":"07358f1b52a6c8ddd4d6ab903bfb044a241395e996f11882b3acfa69b66fe1ec","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214617128,"timestamp_ms":1794380404300,"tx_hash":"EW4xKYa7dpP7Ug2jqi7XpKBZukN43d7quVT1A1SuadSo"},
  {"seq":1,"kind":"paid","agent_id":1,"payment_id":"1e22aaf4af0827cac9232944992147625dac7fa27409a13aa41ddaa23d436c1a","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214623341,"timestamp_ms":1794384132300,"tx_hash":null},
  {"seq":2,"kind":"paid","agent_id":1,"payment_id":"b5f954c9a2e06f8b5fd5e6e9883d865641322477c011f7c63618d98a62d6d8a4","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214627128,"timestamp_ms":1794386404300,"tx_hash":null},
  {"seq":3,"kind":"paid","agent_id":3,"payment_id":"b36f0828850b1df9766fd0eedb7b2add563dc504120e9acb7268ab37896bb2cc","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214629126,"timestamp_ms":1794387603300,"tx_hash":"dyiYb2u2sHZe2Ep5W4oNcMR15McL6igLfjinmJsFU8ih"},
  {"seq":4,"kind":"paid","agent_id":2,"payment_id":"6f3818464a1dfe6c1af53332951254db7ac6b5b7142c2a4ce005a7efba55dad6","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214629626,"timestamp_ms":1794387903300,"tx_hash":null},
  {"seq":5,"kind":"paid","agent_id":1,"payment_id":"fda1e5593a731dc6c00ff18c1e4f856a6cc300111e319fa1168915c3b2c3f95a","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214630696,"timestamp_ms":1794388545300,"tx_hash":null},
  {"seq":6,"kind":"paid","agent_id":2,"payment_id":"9a6a6b0f29b7bde69643995c19d51c3833fa2eb4d2c29c53c4bdddd67886215c","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214633975,"timestamp_ms":1794390512300,"tx_hash":"EtaLwGoRJGr6Zq2bfrmNsvDt1v6kVQNnewhGVouuMUue"},
  {"seq":7,"kind":"paid","agent_id":1,"payment_id":"c0f55369af7d3b7e031e26f3068a2f0cdaaa85b1d8ed403b96b8b56a3058c7a1","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214634256,"timestamp_ms":1794390681300,"tx_hash":null},
  {"seq":8,"kind":"paid","agent_id":4,"payment_id":"24a0cfdedab15fea263d55c14cb0ff2d172cf3cf0355ceb04b0bdbae0d9b9f72","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214636606,"timestamp_ms":1794392091300,"tx_hash":null},
  {"seq":9,"kind":"paid","agent_id":2,"payment_id":"4654a078caceec6f5d3b9ae4552d81d9815d49646c71786b40a8f06e677fd0fd","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214637335,"timestamp_ms":1794392528300,"tx_hash":"3i8A5xrNxgVYbvMCVqMs89TFTJMKFhZJHweLg63fct9K"},
  {"seq":10,"kind":"paid","agent_id":3,"payment_id":"432c898e70067650f57b5beb3c6509f9fb40b20d77450bab37a3744c3dce5924","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214641130,"timestamp_ms":1794394805300,"tx_hash":null},
  {"seq":11,"kind":"paid","agent_id":2,"payment_id":"56aecd74d81906720b3d577ae3ea14b5d9224b6619270996772f512b0b009bff","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":null,"block_height":214641515,"timestamp_ms":1794395036300,"tx_hash":null},
  {"seq":12,"kind":"paid","agent_id":2,"payment_id":"5b13b0c1e9da8406029e13b3bd5f7dde74b0bb72075dda07bbfb32ba910c5e80","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214645238,"timestamp_ms":1794397270300,"tx_hash":"31RDbRUAPFfig3Rdpy8KymCkrLk1EEezkLg5iGUVbRLn"},
  {"seq":13,"kind":"paid","agent_id":5,"payment_id":"31de0297e4042ac2a8ea718e79b94bbc8979d2dd2d3ee5e5532fa8a232fdb659","merchant":"orbit-data.orbit-team.near","amount":"150000","reason":null,"block_height":214647190,"timestamp_ms":1794398441300,"tx_hash":null},
  {"seq":14,"kind":"paid","agent_id":2,"payment_id":"2385588f3aec032237f81f2effbe4d84715db9617715538ee90ccbc5b4c22a29","merchant":"orbit-data.orbit-team.near","amount":"20000","reason":null,"block_height":214650190,"timestamp_ms":1794400241300,"tx_hash":null},
  {"seq":15,"kind":"paid","agent_id":3,"payment_id":"cb22505e80b2099f86637c670ca485c21eb040439ed248a402ed36dadac6b5cf","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214653125,"timestamp_ms":1794402002300,"tx_hash":"B7no7Vk7RT5TsXVt17gxrHaMUXV4WHF9MzpTDLNP3HvN"},
  {"seq":16,"kind":"paid","agent_id":2,"payment_id":"d88ba9c1911374c5a2960a90af989bc5ca84864ad10c1e9396cdd96a7f857f28","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214654331,"timestamp_ms":1794402726300,"tx_hash":null},
  {"seq":17,"kind":"paid","agent_id":2,"payment_id":"04724f3dc56607d52818bbc3aa1364b21b94c8719a9548fd7b9d81c2294c20fb","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214663853,"timestamp_ms":1794408439300,"tx_hash":null},
  {"seq":18,"kind":"paid","agent_id":3,"payment_id":"6eefdd08493b432a2be73d7ad496d1e39bfe980976335f028e2b9834cdd0ee0f","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214665133,"timestamp_ms":1794409207300,"tx_hash":"WPEJ5gMRJ6Agsz9T1g8VmoG6fmceqVPQUnwwhPk955Cj"},
  {"seq":19,"kind":"paid","agent_id":2,"payment_id":"f9a998c8d7cc30b34fbf43e95f01a8ca693e304cab9f4ea5172386ebc874f5b7","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":null,"block_height":214667138,"timestamp_ms":1794410410300,"tx_hash":null},
  {"seq":20,"kind":"rejected","agent_id":2,"payment_id":"0b7fd7fab11cefc52528a7dd677c8e486180adf010cd1ba278ca486c8c21c4b1","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":"org_paused","block_height":214671541,"timestamp_ms":1794413052000,"tx_hash":null},
  {"seq":21,"kind":"paid","agent_id":3,"payment_id":"d46efb71834576d9a79eaf75a6732abdbd814ede49a7ab8ac9ef0efd671dcaab","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214677126,"timestamp_ms":1794416403300,"tx_hash":"pHJmeTAq2Q6MFSr2Aa96Ep6pzxSfjV8wAV3GV1yzwjHE"},
  {"seq":22,"kind":"paid","agent_id":2,"payment_id":"433d1de03c5eb66ad4e353f472c3bb47a04047493b35052d428949e617576916","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214677396,"timestamp_ms":1794416565300,"tx_hash":null},
  {"seq":23,"kind":"paid","agent_id":4,"payment_id":"14cc5d47350cb9042a49e85ef30100a9d50fed6ff40581078ae578ccb42b23d6","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214683378,"timestamp_ms":1794420154300,"tx_hash":null},
  {"seq":24,"kind":"rejected","agent_id":4,"payment_id":"3247cfac19d0e7ebaa358ac9980a86d2c0435be71d8e473a3d030f73465d4e33","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":"expired","block_height":214686123,"timestamp_ms":1794421801000,"tx_hash":"f1eWYycVoANQuWQUM3namRKQ6ULmMreRCdQyXxkf8Ahx"},
  {"seq":25,"kind":"paid","agent_id":2,"payment_id":"3a12d2c44c38fcd5bfaa810b7692e1e654b798b51417319addfa8f4907ceeec8","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214692425,"timestamp_ms":1794425582300,"tx_hash":null},
  {"seq":26,"kind":"failed","agent_id":5,"payment_id":"c36c67474d6a54fb4bdad9797f6ca30ab618feaf5e9559696b24970b35b99d02","merchant":"orbit-data.orbit-team.near","amount":"300000","reason":"transfer_failed","block_height":214696638,"timestamp_ms":1794428110300,"tx_hash":null},
  {"seq":27,"kind":"paid","agent_id":2,"payment_id":"69968ee09ff24f823a258bc384adfb4f3d919c44bd5a56ad2ac30cc5fb08962f","merchant":"orbit-data.orbit-team.near","amount":"20000","reason":null,"block_height":214702166,"timestamp_ms":1794431427300,"tx_hash":"f3ZGRb1WBA1sEmS9SrVr63tj81VQhAkJyF5KB9QxvRTH"},
  {"seq":28,"kind":"paid","agent_id":2,"payment_id":"fad81348e8364e3792dd80e23122ce9c61888a02c1df6d0ad0c4dce9012df907","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214723243,"timestamp_ms":1794444073300,"tx_hash":"d5EssCMPGSr4pTiLQJivP2bP53rVDByWsahnpTY7ST9R"},
  {"seq":29,"kind":"paid","agent_id":2,"payment_id":"084f8d635dc9776d0fb63a40eddf878677c992b1d5ba6761c8257c713fc9c91d","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":null,"block_height":214732623,"timestamp_ms":1794449701300,"tx_hash":"ig2r6dGhyW7YcuZUHK951zBy9RwsY7A7d9QWhAYJ6zni"},
  {"seq":30,"kind":"paid","agent_id":2,"payment_id":"1b51a7a2db959e183b8beb5d3b8732c067af1096a0e894ad737bef15960da01e","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214743468,"timestamp_ms":1794456208300,"tx_hash":"WqicWd3zR1NPhE8tKgdQih2HUs7xemYkxrDoZHoXM92x"},
  {"seq":31,"kind":"paid","agent_id":2,"payment_id":"3c65a9af2f6a05084367ef30cbaa0d23c58a34ba49e962831047c4806e50df14","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214760008,"timestamp_ms":1794466132300,"tx_hash":"sMjhW19BBNGeDFjah1gHam6SkcAgYSJ44DA77TMyvLMD"},
  {"seq":32,"kind":"paid","agent_id":3,"payment_id":"79b801e09bbfc2c4ca888b76e2ba6b0ea6f65915bc80776bef8ef4934365977b","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214761126,"timestamp_ms":1794466803300,"tx_hash":"RDwGL2UgvxnyjEswGtDK9wj6aFSfLoCojy236fcV6QZm"},
  {"seq":33,"kind":"paid","agent_id":3,"payment_id":"85a95e1406a8dbd6bb81bccc7985c99c96171c1a10ffa5bb4c8be865298d7eac","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214773131,"timestamp_ms":1794474006300,"tx_hash":"X1AHj7MD4cf4SMzJhzsN6RPRkHwJGxXgGKKS8Di3CupH"},
  {"seq":34,"kind":"paid","agent_id":2,"payment_id":"ae26c387b95bcdc0117bf7b4a7aa04c9d4cab3f491f0f1204ad28060c1306814","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":null,"block_height":214774038,"timestamp_ms":1794474550300,"tx_hash":"5EPDJAHa3vXsDtibz3ktqpitymC7hvbBcWjNgaHfPbrv"},
  {"seq":35,"kind":"paid","agent_id":4,"payment_id":"5831277e821254d890cd4d9eeaeba0152c715155076f5ba5a2b54d0909004924","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214779353,"timestamp_ms":1794477739300,"tx_hash":"VN6S9G7mY6EtWZqZBBxTGgASJ91bB4TSnEQAdhiS4vuG"},
  {"seq":36,"kind":"paid","agent_id":3,"payment_id":"be67a1f55b16142e6c74139ef95e1720637308b7e59a782f7b418f0f7d20b763","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214785128,"timestamp_ms":1794481204300,"tx_hash":"RdGKGCVEgmR8qg37kfJoPrB8F9Zwff5T4B4danMM95Te"},
  {"seq":37,"kind":"paid","agent_id":2,"payment_id":"30b495370c404f3a7b0c048a0fb159f48c2c2d3915580608ea8622fff02fdef2","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214787773,"timestamp_ms":1794482791300,"tx_hash":"82yxMsAqdEdGXmvWVpkwTMPiF5qvJwgydF39sjf2KS5Q"},
  {"seq":38,"kind":"paid","agent_id":3,"payment_id":"393787e3bf2433dce4c1b5d721ea62cd0aa9ccf0443420d0ae7dfa2fd6510ead","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214791125,"timestamp_ms":1794484802300,"tx_hash":"SaPzsn3uRh7hoErUNKqDdGWXBwbtM6XQ6NbmwisVafUy"},
  {"seq":39,"kind":"paid","agent_id":5,"payment_id":"d117a7a6266536772410e2804b981e8db10abd44014c6c11f34d2a9caae396a6","merchant":"orbit-data.orbit-team.near","amount":"400000","reason":null,"block_height":214792185,"timestamp_ms":1794485438300,"tx_hash":"Vr1NSrPCaj53krZaZwBbcm7Fcn22hDvKuPuBnE12A5Qu"},
  {"seq":40,"kind":"paid","agent_id":2,"payment_id":"37f4e321dbc8acf74814b53b99e6cef60f4a848b4e77d93f4f04c1297204c7a1","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":null,"block_height":214796926,"timestamp_ms":1794488283300,"tx_hash":"jviXQQDBDbjFWNkuKrsiiTPdtqbN8WpKyyqw82a77w6B"},
  {"seq":41,"kind":"paid","agent_id":3,"payment_id":"59b1e8de15c4476981cd36181499bd2100e0e8b198cfad344ea9839bd7a7f563","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214797130,"timestamp_ms":1794488405300,"tx_hash":"3X6L4hYUqRu1Gaa9XaJpLKYxSDu3Svi4YC4wmmZ23HuK"},
  {"seq":42,"kind":"paid","agent_id":3,"payment_id":"5b4d676e71b5d46076d0a52ce9866d388fb04f41952aaf555f4918c8c35fd316","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214800126,"timestamp_ms":1794490203300,"tx_hash":"g76217bcbVnde6C87rCpCs6P8z1gFme6GFDLHZpoqqqX"},
  {"seq":43,"kind":"paid","agent_id":4,"payment_id":"439c65c6c2c2b66e72ed84d8c149dd1d6b2b8f89a1c2832add53c734ea7d9b1e","merchant":"orbit-data.orbit-team.near","amount":"250000","reason":null,"block_height":214801608,"timestamp_ms":1794491092300,"tx_hash":"FcjDZYSNgzJcDvURH2XBrUNT8LPQeqW282PLFm62e23y"},
  {"seq":44,"kind":"paid","agent_id":6,"payment_id":"afde2aa4850146e3be88ef89cc7612e6e1248885e8dde9911b6f8988d6be8f78","merchant":"orbit-data.orbit-team.near","amount":"10000","reason":null,"block_height":214802930,"timestamp_ms":1794491885300,"tx_hash":"cHNaodZ3AmLZX8utS1p4qdAQnrHfUKgsWiwP2sNV2TBg"},
  {"seq":45,"kind":"rejected","agent_id":3,"payment_id":"34dff20ea7c28dc43f62f196568046962164b34882ee2a382f2196e8ec87ca5b","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":"over_agent_daily_limit","block_height":214803126,"timestamp_ms":1794492003000,"tx_hash":"jpZHAx1qM6WMF5RHEsFMfvXwfYG5tTFE8NA5GMQTtm3y"},
  {"seq":46,"kind":"rejected","agent_id":6,"payment_id":"3424ae332d27a95bf979429a76aeb60af93ae3a65a017b129d12ce3eb7334ed8","merchant":"unlisted-shop.orbit-team.near","amount":"50000","reason":"merchant_not_allowed","block_height":214803338,"timestamp_ms":1794492130000,"tx_hash":"tXspG1FuAV1r3NmuD24YQ5pyNoXSET4CPjwuYPNWzxBp"},
  {"seq":47,"kind":"rejected","agent_id":6,"payment_id":"77ad85322f609fea9d014bb0a39dd74c3658c091422b9f0b527d25689ddc9131","merchant":"orbit-data.orbit-team.near","amount":"2000000","reason":"over_per_payment_limit","block_height":214803389,"timestamp_ms":1794492161000,"tx_hash":"13A6L3SCfv9Exsu16aq5GnxcFPPPPXeTk7qBH2baJJu6"},
  {"seq":48,"kind":"rejected","agent_id":6,"payment_id":"afde2aa4850146e3be88ef89cc7612e6e1248885e8dde9911b6f8988d6be8f78","merchant":"orbit-data.orbit-team.near","amount":"10000","reason":"duplicate_payment","block_height":214803446,"timestamp_ms":1794492195000,"tx_hash":"1fL3eoFWkyab4xNsbSfZim8ufmPET4WPp8o9qouqpKdd"},
  {"seq":49,"kind":"rejected","agent_id":6,"payment_id":"857a427255c0c78b68ca7762348b8d319231d1293cf2ce04e46b4c1eede70b61","merchant":"unlisted-shop.orbit-team.near","amount":"50000","reason":"merchant_not_allowed","block_height":214803508,"timestamp_ms":1794492232000,"tx_hash":"MjpUYri9K88PbihZthBKC74xeSi7wwq8YQPd6gBdYQPY"},
  {"seq":50,"kind":"rejected","agent_id":6,"payment_id":"14deae0768006145f2c28d4ca8e84525e342ae2b49e69fbeb45350e41a70e9db","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":"agent_paused","block_height":214803741,"timestamp_ms":1794492372000,"tx_hash":"c8FTKVndCK59cPtr2G9xX6aos4FubzG4nMNxogH5ZT1x"},
  {"seq":51,"kind":"rejected","agent_id":6,"payment_id":"bb2b6829b0c5b337e4ff417b7e66891e4cdb612429e94bf91473922538a89950","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":"agent_paused","block_height":214803971,"timestamp_ms":1794492510000,"tx_hash":"3tBvqGX3FxdHwxHtRxgJkh2MbYAQyvDnVBCUcsQxc44B"},
  {"seq":52,"kind":"rejected","agent_id":6,"payment_id":"da1e02ff9e2bac7c07aa63480bb7e51c1cbbdff5c814cddcbf1dde7ff37e260b","merchant":"orbit-data.orbit-team.near","amount":"50000","reason":"agent_paused","block_height":214804224,"timestamp_ms":1794492662000,"tx_hash":"gEhC74J7DeMCLSU6s5xKfHDf1vsmFbayK5itdiCVPu3Y"},
  {"seq":53,"kind":"paid","agent_id":2,"payment_id":"3d49e04cd53b6743f4df96d0ef26e8389612c425ea6a390e7a83797579c8e6ed","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":null,"block_height":214805301,"timestamp_ms":1794493308300,"tx_hash":"obKH731oNHuY9rUFKGmx3hsZoUwbKu3HEM4s3HffG19L"},
  {"seq":54,"kind":"rejected","agent_id":3,"payment_id":"d24be6846142cc44af520d4d6dff48faa2b1771843859b22a904787bb2178c74","merchant":"orbit-data.orbit-team.near","amount":"100000","reason":"over_agent_daily_limit","block_height":214806124,"timestamp_ms":1794493802000,"tx_hash":"gYh2XgPe5nbokMoqn3NjcawBdNUU6dRVzpU1e8z4cBp7"},
];

export const MVP_OP_TX = ["Q81Qn212FMhJ8Q8HCM8JX6ht5VaUivAnGEQtFitfuiP1", "gTK5D3jgYPCCVuTMdzwLAEdJGF4YzRi1pfWLLk8fzd6Q"] as const;
export const MVP_NEW_PK = "ed25519:yxE6fWsB4TfASsBdbkcsG8YKCfE5iBB4Qmt9q9a6TGSQ";
