// Licensed under the Apache License, Version 2.0.

//! Byte shapes and texts checked against etcd's own Go code.
//!
//! Each expected value below was printed by a Go test in an etcd raft checkout
//! at commit c51f010 (Go 1.26, `proto.Marshal`, `proto.Size`, `fmt`).

use raft::gostd::Quote;
use raft::raftpb as pb;
use raft::raftpb::ConfChangeI;
use raft_harness::gofmt::Hex;

fn hex(b: &[u8]) -> String {
    Hex(b).to_string()
}

#[test]
fn conf_change_bytes() {
    let cc1 = pb::ConfChange { r#type: Some(pb::ConfChangeAddNode), node_id: Some(2), ..Default::default() };
    assert_eq!(hex(&cc1.marshal()), "10001802");
    let cc2 = pb::ConfChange {
        r#type: Some(pb::ConfChangeRemoveNode),
        node_id: Some(300),
        id: Some(7),
        context: Some(b"ctx".to_vec()),
    };
    assert_eq!(hex(&cc2.marshal()), "0807100118ac022203637478");
    assert_eq!(hex(&pb::ConfChange::default().marshal()), "");
    assert_eq!(hex(&pb::ConfChangeV2::default().marshal()), "");
    let v2b = pb::ConfChangeV2 {
        transition: Some(pb::ConfChangeTransitionJointExplicit),
        changes: vec![
            pb::ConfChangeSingle { r#type: Some(pb::ConfChangeAddLearnerNode), node_id: Some(3) },
            pb::ConfChangeSingle { r#type: Some(pb::ConfChangeRemoveNode), node_id: Some(1) },
            pb::ConfChangeSingle::default(),
        ],
        context: Some(Vec::new()),
    };
    assert_eq!(hex(&v2b.marshal()), "080212040803100312040801100112001a00");
    assert_eq!(hex(&cc1.as_v2().marshal()), "120408001002");

    // What is written can be read back.
    for cc in [&cc1, &cc2, &pb::ConfChange::default()] {
        assert_eq!(&pb::ConfChange::unmarshal(&cc.marshal()).unwrap(), cc);
    }
    for cc in [&v2b, &cc1.as_v2(), &pb::ConfChangeV2::default()] {
        assert_eq!(&pb::ConfChangeV2::unmarshal(&cc.marshal()).unwrap(), cc);
    }
    // A cut message is an error, not a panic.
    assert!(pb::ConfChange::unmarshal(&[0x22, 0x05, 0x01]).is_err());
    assert!(pb::ConfChangeV2::unmarshal(&[0x08]).is_err());

    let (typ, data) = pb::marshal_conf_change(Some(&cc1));
    assert_eq!((typ, data.as_deref().map(hex)), (pb::EntryConfChange, Some("10001802".to_string())));
    let (typ, data) = pb::marshal_conf_change(Some(&cc1.as_v2()));
    assert_eq!((typ, data.as_deref().map(hex)), (pb::EntryConfChangeV2, Some("120408001002".to_string())));
    assert_eq!(pb::marshal_conf_change(None), (pb::EntryConfChangeV2, None));
}

#[test]
fn entry_sizes() {
    assert_eq!(pb::Entry::default().size(), 0);
    assert_eq!(pb::Entry { term: Some(1), index: Some(11), ..Default::default() }.size(), 4);
    let e3 = pb::Entry {
        term: Some(300),
        index: Some(70000),
        r#type: Some(pb::EntryConfChangeV2),
        data: Some(b"hello".to_vec()),
    };
    assert_eq!(e3.size(), 16);
    let e4 = pb::Entry { term: Some(0), index: Some(0), r#type: Some(pb::EntryNormal), data: Some(Vec::new()) };
    assert_eq!(e4.size(), 8);
    assert_eq!(pb::Entry { data: Some(vec![0; 200]), ..Default::default() }.size(), 203);
}

#[test]
fn enum_names() {
    let s = format!(
        "{}|{}|{}|{}|{}|{}",
        pb::MessageType(3),
        pb::MessageType(99),
        pb::EntryType(2),
        pb::ConfChangeType(7),
        pb::ConfChangeTransition(1),
        pb::ConfChangeType(3).0
    );
    assert_eq!(s, "MsgApp|99|EntryConfChangeV2|7|ConfChangeTransitionJointImplicit|3");
    assert_eq!(pb::MessageType::from_name("MsgForgetLeader"), Some(pb::MsgForgetLeader));
    assert_eq!(pb::MessageType::from_name("nope"), None);
}

#[test]
fn quote() {
    assert_eq!(Quote("a\"b\\c\n\t\x01é".as_bytes()).to_string(), "\"a\\\"b\\\\c\\n\\t\\x01é\"");
    assert_eq!(Quote(&[0xff, b'a']).to_string(), "\"\\xffa\"");
}

#[test]
fn conf_changes_from_string() {
    let ccs = pb::conf_changes_from_string("v1 l2 r3 u4").unwrap();
    assert_eq!(pb::conf_changes_to_string(&ccs), "v1 l2 r3 u4");
    assert_eq!(
        raft::confchange::describe(&ccs),
        "ConfChangeAddNode(1) ConfChangeAddLearnerNode(2) ConfChangeRemoveNode(3) ConfChangeUpdateNode(4)"
    );
    assert!(pb::conf_changes_from_string("").unwrap().is_empty());
    assert_eq!(pb::conf_changes_from_string("v").unwrap_err().to_string(), "unknown token v");
    assert_eq!(pb::conf_changes_from_string("x1").unwrap_err().to_string(), "unknown input: x1");
    assert_eq!(
        pb::conf_changes_from_string("vx").unwrap_err().to_string(),
        "strconv.ParseUint: parsing \"x\": invalid syntax"
    );
    assert_eq!(
        pb::conf_changes_from_string("v99999999999999999999").unwrap_err().to_string(),
        "strconv.ParseUint: parsing \"99999999999999999999\": value out of range"
    );
}
