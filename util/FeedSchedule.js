const fs = require('fs')
const getArticles = require('../rss/cycleSingle.js')
const config = require('../config.json')
const configChecks = require('./configCheck.js')
const debugFeeds = require('../util/debugFeeds.js').list
const events = require('events')
const childProcess = require('child_process')
const storage = require('./storage.js') // All properties of storage must be accessed directly due to constant changes
const logLinkErr = require('./logLinkErrs.js')
const allScheduleWords = storage.allScheduleWords
const FAIL_LIMIT = config.feedSettings.failLimit
const WARN_LIMIT = Math.floor(config.feedSettings.failLimit * 0.75) < FAIL_LIMIT ? Math.floor(config.feedSettings.failLimit * 0.75) : Math.floor(config.feedSettings.failLimit * 0.5) < FAIL_LIMIT ? Math.floor(config.feedSettings.failLimit * 0.5) : 0
const BATCH_SIZE = config.advanced.batchSize

module.exports = function (bot, callback, schedule) {
  const refreshTime = schedule.refreshTimeMinutes ? schedule.refreshTimeMinutes : config.feedSettings.refreshTimeMinutes
  let timer // Timer for the setInterval
  let cycleInProgress
  let processorList = []
  let regBatchList = []
  let modBatchList = [] // Batch of sources with cookies
  let startTime // Tracks cycle times
  let cycleFailCount = 0
  let cycleTotalCount = 0

  this.inProgress = cycleInProgress
  this.cycle = new events.EventEmitter()
  let cycle = this.cycle

  const sourceList = new Map()
  const modSourceList = new Map()

  function addFailedFeed (link, rssList) {
    const failedLinks = storage.failedLinks
    storage.failedLinks[link] = (failedLinks[link]) ? failedLinks[link] + 1 : 1

    if (failedLinks[link] === WARN_LIMIT) {
      if (config.feedSettings.notifyFail !== true) return
      for (var i in rssList) {
        const source = rssList[i]
        if (source.link === link) bot.channels.get(source.channel).send(`**WARNING** - Feed link <${link}> is nearing the connection failure limit. Once it has failed, it will not be retried until is manually refreshed. See \`${config.botSettings.prefix}rsslist\` for more information.`).catch(err => console.log(`Unable to send reached warning limit for feed ${link} in channel ${source.channel}`, err.message || err))
      }
    } else if (failedLinks[link] >= FAIL_LIMIT) {
      storage.failedLinks[link] = (new Date()).toString()
      console.log(`RSS Error: ${link} has passed the fail limit (${FAIL_LIMIT}). Will no longer retrieve.`)
      if (config.feedSettings.notifyFail !== true) return
      for (var j in rssList) {
        const source = rssList[j]
        if (source.link === link) bot.channels.get(source.channel).send(`**ATTENTION** - Feed link <${link}> has reached the connection failure limit and will not be retried until is manually refreshed. See \`${config.botSettings.prefix}rsslist\` for more information. A backup for this server has been provided in case this feed is subjected to forced removal in the future.`).catch(err => console.log(`Unable to send reached failure limit for feed ${link} in channel ${source.channel}`, err.message || err))
      }
    }
  }

  function reachedFailCount (link) {
    return typeof storage.failedLinks[link] === 'string' // string indicates it has reached the fail count, and is the date of when it failed
  }

  function addToSourceLists (guildRss, guildId) { // rssList is an object per guildRss
    const rssList = guildRss.sources

    function delegateFeed (rssName) {
      if (rssList[rssName].advanced && rssList[rssName].advanced.size() > 0) { // Special source list for feeds with unique settings defined
        let linkList = {}
        linkList[rssName] = rssList[rssName]
        modSourceList.set(rssList[rssName].link, linkList)
      } else if (sourceList.has(rssList[rssName].link)) { // Each item in the sourceList has a unique URL, with every source with this the same link aggregated below it
        let linkList = sourceList.get(rssList[rssName].link)
        linkList[rssName] = rssList[rssName]
      } else {
        let linkList = {}
        linkList[rssName] = rssList[rssName]
        sourceList.set(rssList[rssName].link, linkList)
      }
    }

    for (var rssName in rssList) {
      if (configChecks.checkExists(rssName, rssList[rssName], false) && configChecks.validChannel(bot, guildId, rssList[rssName]) && !reachedFailCount(rssList[rssName].link)) {
        if (storage.linkTracker[rssName] === schedule.name) { // If assigned to a schedule
          delegateFeed(rssName)
        } else if (schedule.name !== 'default' && !storage.linkTracker[rssName]) { // If current feed schedule is a custom one and is not assigned
          const keywords = schedule.keywords
          for (var q in keywords) {
            if (rssList[rssName].link.includes(keywords[q])) {
              storage.linkTracker[rssName] = schedule.name // Assign this feed to this schedule so no other feed schedule can take it on subsequent cycles
              delegateFeed(rssName)
              console.log(`RSS Info: Undelegated feed ${rssName} (${rssList[rssName].link}) has been delegated to custom schedule ${schedule.name}`)
            }
          }
        } else if (!storage.linkTracker[rssName]) { // Has no schedule, was not previously assigned, so see if it can be assigned to default
          let reserved = false
          for (var w in allScheduleWords) { // If it can't be assigned to default, it will eventually be assigned to other schedules when they occur
            if (rssList[rssName].link.includes(allScheduleWords[w])) reserved = true
          }
          if (!reserved) {
            storage.linkTracker[rssName] = 'default'
            delegateFeed(rssName)
          }
        }
      }
    }
  }

  function genBatchLists () { // Each batch is a bunch of links. Too many links at once will cause request failures.
    let batch = new Map()

    sourceList.forEach(function (rssList, link) { // rssList per link
      if (batch.size >= BATCH_SIZE) {
        regBatchList.push(batch)
        batch = new Map()
      }
      batch.set(link, rssList)
    })

    if (batch.size > 0) regBatchList.push(batch)

    batch = new Map()

    modSourceList.forEach(function (source, link) { // One RSS source per link instead of an rssList
      if (batch.size >= BATCH_SIZE) {
        modBatchList.push(batch)
        batch = new Map()
      }
      batch.set(link, source)
    })

    if (batch.size > 0) modBatchList.push(batch)
  }

  function connect () {
    if (cycleInProgress) {
      if (!config.advanced.processorMethod || config.advanced.processorMethod === 'single') {
        console.log(`RSS Info: Previous ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ') ' : ''} was unable to finish, attempting to start new cycle. If repeatedly seeing this message, consider increasing your refresh time.`)
        cycleInProgress = false
      } else {
        console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ' : ''}Processors from previous cycle were not killed (${processorList.length}). Killing all processors now. If repeatedly seeing this message, consider increasing your refresh time.`)
        for (var x in processorList) {
          processorList[x].kill()
        }
        processorList = []
      }
    }
    const currentGuilds = storage.currentGuilds
    startTime = new Date()
    cycleInProgress = true
    regBatchList = []
    modBatchList = []
    cycleFailCount = 0
    cycleTotalCount = 0

    modSourceList.clear() // Regenerate source lists on every cycle to account for changes to guilds
    sourceList.clear()
    currentGuilds.forEach(addToSourceLists)
    genBatchLists()

    if (sourceList.size + modSourceList.size === 0) {
      cycleInProgress = false
      return finishCycle(true)// console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ' : ''}RSS Info: Finished ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ')' : ''}. No feeds to retrieve.`)
    }

    switch (config.advanced.processorMethod) {
      case 'single':
        getBatch(0, regBatchList, 'regular')
        break
      case 'isolated':
        getBatchIsolated(0, regBatchList, 'regular')
        break
      case 'parallel':
        getBatchParallel()
    }
  }

  function getBatch (batchNumber, batchList, type) {
    const failedLinks = storage.failedLinks
    if (batchList.length === 0) return getBatch(0, modBatchList, 'modded')
    const currentBatch = batchList[batchNumber]
    let completedLinks = 0

    currentBatch.forEach(function (rssList, link) {
      var uniqueSettings
      for (var modRssName in rssList) {
        if (rssList[modRssName].advanced && rssList[modRssName].advanced.size() > 0) {
          uniqueSettings = rssList[modRssName].advanced
        }
      }

      getArticles(link, rssList, uniqueSettings, function (err, linkCompletion) {
        if (err) logLinkErr({link: linkCompletion.link, content: err})
        if (linkCompletion.status === 'article') {
          if (debugFeeds.includes(linkCompletion.article.rssName)) console.log(`DEBUG ${linkCompletion.article.rssName}: Emitted article event.`)
          return cycle.emit('article', linkCompletion.article)
        }
        if (linkCompletion.status === 'failed' && FAIL_LIMIT !== 0) {
          ++cycleFailCount
          addFailedFeed(linkCompletion.link, linkCompletion.rssList)
        } else if (linkCompletion.status === 'success' && failedLinks[linkCompletion.link]) delete failedLinks[linkCompletion.link]

        if (++completedLinks === currentBatch.size) {
          if (batchNumber !== batchList.length - 1) setTimeout(getBatch, 200, batchNumber + 1, batchList, type)
          else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatch, 200, 0, modBatchList, 'modded')
          else return finishCycle()
        }
      })
    })
  }

  function getBatchIsolated (batchNumber, batchList, type) {
    const failedLinks = storage.failedLinks
    if (batchList.length === 0) return getBatchIsolated(0, modBatchList, 'modded')
    const currentBatch = batchList[batchNumber]
    let completedLinks = 0

    processorList.push(childProcess.fork('./rss/cycleProcessor.js'))

    const processorIndex = processorList.length - 1
    const processor = processorList[processorIndex]

    currentBatch.forEach(function (rssList, link) {
      let uniqueSettings
      for (var modRssName in rssList) {
        if (rssList[modRssName].advanced && rssList[modRssName].advanced.size() > 0) {
          uniqueSettings = rssList[modRssName].advanced
        }
      }
      processor.send({type: 'initial', link: link, rssList: rssList, uniqueSettings: uniqueSettings, debugFeeds: debugFeeds})
    })

    processor.on('message', function (linkCompletion) {
      if (linkCompletion.status === 'article') return cycle.emit('article', linkCompletion.article)
      if (linkCompletion.status === 'failed') {
        ++cycleFailCount
        if (FAIL_LIMIT !== 0) addFailedFeed(linkCompletion.link, linkCompletion.rssList)
      } else if (linkCompletion.status === 'success' && failedLinks[linkCompletion.link]) delete failedLinks[linkCompletion.link]

      cycleTotalCount++
      if (++completedLinks === currentBatch.size) {
        processor.kill()
        processorList.splice(processorIndex, 1)
        if (batchNumber !== batchList.length - 1) setTimeout(getBatchIsolated, 200, batchNumber + 1, batchList, type)
        else if (type === 'regular' && modBatchList.length > 0) setTimeout(getBatchIsolated, 200, 0, modBatchList, 'modded')
        else finishCycle()
      }
    })
  }

  function getBatchParallel () {
    const failedLinks = storage.failedLinks
    const totalBatchLengths = regBatchList.length + modBatchList.length
    let completedBatches = 0

    function deployProcessor (batchList, index) {
      let completedLinks = 0
      const currentBatch = batchList[index]
      processorList.push(childProcess.fork('./rss/cycleProcessor.js'))

      const processorIndex = processorList.length - 1
      const processor = processorList[processorIndex]

      processor.on('message', function (linkCompletion) {
        if (linkCompletion.status === 'article') return cycle.emit('article', linkCompletion.article)
        if (linkCompletion.status === 'failed' && FAIL_LIMIT !== 0) {
          ++cycleFailCount
          addFailedFeed(linkCompletion.link, linkCompletion.rssList)
        } else if (linkCompletion.status === 'success' && failedLinks[linkCompletion.link]) delete failedLinks[linkCompletion.link]

        if (++completedLinks === currentBatch.size) {
          completedBatches++
          processor.kill()
          if (completedBatches === totalBatchLengths) {
            processorList = []
            finishCycle()
          }
        }
      })

      currentBatch.forEach(function (rssList, link) {
        var uniqueSettings
        for (var modRssName in rssList) {
          if (rssList[modRssName].advanced && rssList[modRssName].advanced.size() > 0) {
            uniqueSettings = rssList[modRssName].advanced
          }
        }
        processor.send({type: 'initial', link: link, rssList: rssList, uniqueSettings: uniqueSettings, debugFeeds: debugFeeds})
      })
    }

    for (var i in regBatchList) { deployProcessor(regBatchList, i) }
    for (var y in modBatchList) { deployProcessor(modBatchList, y) }
  }

  function finishCycle (noFeeds) {
    const failedLinks = storage.failedLinks
    if (bot.shard && bot.shard.count > 1) bot.shard.send({type: 'scheduleComplete', refreshTime: refreshTime})
    if (noFeeds) return console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ' : ''}RSS Info: Finished ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ')' : ''}. No feeds to retrieve.`)

    if (processorList.length === 0) cycleInProgress = false

    if (bot.shard) {
      bot.shard.broadcastEval(`require(require('path').dirname(require.main.filename) + '/util/storage.js').failedLinks = JSON.parse('${JSON.stringify(failedLinks)}');`)
      .then(() => {
        try { fs.writeFileSync('./settings/failedLinks.json', JSON.stringify(failedLinks, null, 2)) } catch (e) { console.log(`Unable to update failedLinks.json on end of cycle, reason: ${e}`) }
      })
      .catch(err => console.log(`Error: Unable to broadcast eval failedLinks update on cycle end for shard ${bot.shard.id}:`, err.message || err))
    } else try { fs.writeFileSync('./settings/failedLinks.json', JSON.stringify(failedLinks, null, 2)) } catch (e) { console.log(`Unable to update failedLinks.json on end of cycle, reason: ${e}`) }

    var timeTaken = ((new Date() - startTime) / 1000).toFixed(2)
    console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ' : ''}RSS Info: Finished ${schedule.name === 'default' ? 'default ' : ''}feed retrieval cycle${schedule.name !== 'default' ? ' (' + schedule.name + ')' : ''}${cycleFailCount > 0 ? ' (' + cycleFailCount + '/' + cycleTotalCount + ' failed)' : ''}. Cycle Time: ${timeTaken}s.`)
    if (bot.shard && bot.shard.count > 1) bot.shard.send({type: 'scheduleComplete', refreshTime: refreshTime})
  }

  if (!bot.shard || (bot.shard && bot.shard.count === 1)) timer = setInterval(connect, refreshTime * 60000) // Only create an interval for itself if there is no sharding

  if (timer) console.log(`${bot.shard ? 'SH ' + bot.shard.id + ' ' : ''}RSS Info: Schedule '${schedule.name}' has begun.`)

  this.stop = function () {
    clearInterval(timer)
    if (timer) console.log(`RSS Info: Schedule '${schedule.name}' has stopped.`)
  }

  this.start = function () {
    if (!bot.shard || (bot.shard && bot.shard.count === 1)) timer = setInterval(connect, refreshTime * 60000)
  }

  this.run = connect
  this.refreshTime = refreshTime

  callback(this.cycle)
  return this
}
