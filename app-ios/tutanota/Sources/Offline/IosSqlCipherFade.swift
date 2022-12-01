import Foundation

enum listIdLockState {
  case waitingForListIdUnlock
  case listIdUnlocked
}

class IosSqlCipherFacade: SqlCipherFacade {
  private var db: SqlCipherDb? = nil
  var openedDb: SqlCipherDb {
    get {
      guard let db = self.db else {
        fatalError("no db opened!")
      }
      return db
    }
  }

  private var listIdLocks = Dictionary<String, CurrentValueSubject<Void, Never>>

  func run(_ query: String, _ params: [TaggedSqlValue]) async throws {
    let prepped = try! self.openedDb.prepare(query: query)
    try! prepped.bindParams(params).run()
    return
  }

  func get(_ query: String, _ params: [TaggedSqlValue]) async throws -> [String : TaggedSqlValue]? {
    let prepped = try! self.openedDb.prepare(query: query)
    return try! prepped.bindParams(params).get()
  }

  func all(_ query: String, _ params: [TaggedSqlValue]) async throws -> [[String : TaggedSqlValue]] {
    let prepped = try! self.openedDb.prepare(query: query)
    return try! prepped.bindParams(params).all()
  }

  func openDb(_ userId: String, _ dbKey: DataWrapper) async throws {
    let db = SqlCipherDb(userId)
    try db.open(dbKey.data)
    self.db = db
  }

  func closeDb() async throws {
    if self.db == nil {
      return
    }
    self.db!.close()
    self.db = nil
  }

  func deleteDb(_ userId: String) async throws {
    if let db = self.db, db.userId == userId {
        db.close()
    }

    do {
      try FileUtils.deleteFile(path: makeDbPath(userId))
    } catch {
      let err = error as NSError
      if err.domain == NSPOSIXErrorDomain && err.code == ENOENT {
        // we don't care
      } else if let underlyingError = err.userInfo[NSUnderlyingErrorKey] as? NSError,
                underlyingError.domain == NSPOSIXErrorDomain && underlyingError.code == ENOENT {
        // we don't care either
      } else {
        throw error
      }
    }
  }

  // FIXME

  // continue here !

  func lockRangesDbAccess(_ listId: String) async throws {
	/// awaiting for the first and hopefully only void object in this publisher
    /// could be simpler but .values is iOS > 15
    if (listIdUnlocked)
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
	  // first will end the subscription after the first match so we don't need to cancel manually
	  // (it is anyway hard to do as .sink() is called sync right away before we get subscription)
	  let
	  let _ = self.initialized
		.first(where: { $0 == .initReceived })
		.sink { v in
		  continuation.resume()
	  }
	}
  }

  func unlockRangesDbAccess(_ listId: String) async throws {
  	self.listIdLocks[listId].send(.listIdUnlocked)
  }
}
