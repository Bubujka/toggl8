#!/usr/bin/env node
var EnvBang = new require('envbang-node');
var envbang = new EnvBang(['TOGGL8_DEFAULT_WID', 'TOGGL_API_TOKEN']);
envbang.check();


var request = require('request');
var moment = require('moment');
var qs = require('querystring');
var _ = require('underscore');
var async = require('async');
var chalk = require('chalk');
var inquirer = require('inquirer');


var toggl = {
  _url: 'https://www.toggl.com/api/v8',
  get: function(pth, next){
    request
      .get(this._url+pth, function(err,res, body){
        if(err){
          return next(err);
        }
        next(null, JSON.parse(body));
      })
      .auth(process.env.TOGGL_API_TOKEN, 'api_token', true);
  }
};

function hr(){
  console.log();
}
function next(err){
  console.log(chalk.bgRed.bold('Произошла ошибка!'));
  console.log(err);
  process.exit(1);
}
function h(i){
  return (Math.floor(i / 3600 * 100) / 100) + 'h.';
}
async.auto({
  workspaces: function(cb){
    toggl.get('/workspaces', function(err,data){
      if(err){
        return cb(err);
      }
      cb(null, data);
    });
  },
  wid: ['workspaces', function(cb, state){
    var wspaces = _.map(state.workspaces, function(itm){
      return {
        name: itm.name,
        value: ""+itm.id
      };
    });
    inquirer.prompt([ {
      type: "list",
      message: "В каком воркспэйсе пересчитать тайминг?",
      name: "workspace",
      choices: wspaces,
      default: process.env.TOGGL8_DEFAULT_WID

    }], function(answers){
      if(!answers.workspace){
        return cb('abort');
      }
      cb(null, parseInt(answers.workspace));
    });
  }],
  day: ['wid', function(cb){
    var days = [];
    var t = moment();
    var suffix = '';
    for (var i = 0; i < 61; i ++) {
      if(i === 0){
        suffix = ' (сегодня)';
      }else if(i === 1){
        suffix = ' (вчера)';
      }else{
        suffix = '';
      }
      days.push({
        name: t.format('YYYY-MM-DD')+suffix,
        value: t.format('YYYY-MM-DD')
      });
      t.subtract(1, 'days');
    }

    inquirer.prompt([ {
      type: "list",
      message: "За какой день обрабатывать тайминг?",
      name: "value",
      choices: days,
      default: moment().format('YYYY-MM-DD')
    }], function(answers){
      if(!answers.value){
        return cb('abort');
      }
      cb(null, moment(answers.value));
    });
  }],

  user: ['wid', 'day', function(cb, state){
    toggl.get('/me', function(err, data){
      if(err){
        return cb(err);
      }
      hr();
      console.log(
        'Обновление данных для "'+
        chalk.green(data.data.fullname)+
        '" за '+chalk.green(state.day.format('DD-MM-YYYY')));
      cb(null, data);
    });
  }],

  workspace: ['wid', 'user', function(cb, state){
    toggl.get('/workspaces/'+state.wid, function(err,data){
      if(err){
        return cb(err);
      }
      console.log('Рабочее пространство: '+chalk.green(data.data.name));
      hr();
      cb(null, data);
    });
  }],

  entries: ['workspace', function(cb,state){
    var url = '/time_entries?'+
      qs.stringify({
        start_date:state.day.startOf('day').toISOString(),
        end_date:state.day.endOf('day').toISOString() });
    toggl.get(url, function(err, data){
      if(err){
        return cb(err);
      }
      var sum = _.reduce(data, function(memo, itm){ return memo + itm.duration; }, 0);
      console.log('Всего за день было записей: ' +
                  chalk.green(data.length) +
                  ' на ' +
                  chalk.green(h(sum)));
      cb(null, data);
    });
  }],
  hours: ['entries', function(cb){
    inquirer.prompt([ {
      type: "Input",
      message: "До скольки часов дополнить?",
      name: "value",
      default: 8
    }], function(answers){
      if(!answers.value){
        return cb('abort');
      }
      cb(null, parseInt(answers.value));
    });
  }],
  filtered_entries: ['hours', 'entries', function(cb,state){
    var filtered_entries = _.filter(state.entries, function(itm){
      return itm.wid === state.wid;
    });
    var sum = _.reduce(filtered_entries, function(memo, itm){ return memo + itm.duration; }, 0);
    console.log('Из них в воркспэйсе: ' +
                chalk.green(filtered_entries.length) +
                ' на ' +
                chalk.green(h(sum)));
    if(filtered_entries.length === 0){
      return cb('nothing');
    }
    console.log("Будет дополнительно добавлено: " + chalk.green(h(3600 * state.hours - sum)));
    hr();
    for(var i in filtered_entries){
      var t = filtered_entries[i];
      console.log(' - '+t.description +' '+
                  chalk.green(h(t.duration)) + ' → ' +
                  chalk.green(h( t.duration / sum * 3600 * state.hours)));
    }

    hr();
    cb(null, filtered_entries);
  }],

  sum: ['filtered_entries', function(cb,state){
    var sum = _.reduce(state.filtered_entries, function(memo, itm){ return memo + itm.duration; }, 0);
    cb(null, sum);
  }],

  confirm: ['sum', function(cb, state){
    inquirer.prompt([{
      type: "confirm",
      name: "recalculate",
      message: "Привести все данные к "+state.hours+"-часовому рабочему дню",
      default: true
    }], function(answers){
      if(!answers.recalculate){
        cb('abort');
      }else{
        cb();
      }
    });
  }],

  update: ['confirm', 'sum', 'filtered_entries', function(cb, state){
    async.eachLimit(
      state.filtered_entries,
      2,
      function(entry, next){
        var nentry = _.clone(entry);
        nentry.start = null;
        nentry.stop = null;
        nentry.duration = Math.floor(entry.duration / state.sum * 3600 * state.hours);
        nentry.duration_only = true;
        request
          .put('https://www.toggl.com/api/v8/time_entries/'+entry.id,
                { json: { time_entry: nentry } },
                function(err, res, body){
                  if(err){
                    return next(err);
                  }
                  console.log('- Обновлено '+chalk.green(nentry.description));
                  next(null, body);
                })
          .auth(process.env.TOGGL_API_TOKEN, 'api_token', true);
      }, cb);
  }]

},function(err){

  hr();
  if(err){
    if(err === 'abort'){
      console.log(chalk.bgGreen('Нуууу ок +_+'));
      process.exit(0);
    }
    if(err === 'nothing'){
      console.log(chalk.bgGreen('Нечего обрабатывать'));
      process.exit(0);
    }
    return next(err);
  }
  console.log('');
  console.log(chalk.bgGreen('Всё готово!'));

});
