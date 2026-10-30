// Slack's standard emoji shortcodes, for threads read through the Slack connector (which returns `:name:` text).
// ponytail: a curated list of the shortcodes people actually use; unknown and custom emoji stay as `:name:` text.
// Vendor the full emoji-datasource table if misses become common.
const EMOJI = Object.fromEntries(`
+1 👍|thumbsup 👍|-1 👎|thumbsdown 👎|ok_hand 👌|clap 👏|raised_hands 🙌|pray 🙏|wave 👋|muscle 💪|point_up ☝️|point_up_2 👆
point_down 👇|point_left 👈|point_right 👉|raised_hand ✋|hand ✋|v ✌️|crossed_fingers 🤞|metal 🤘|call_me_hand 🤙|handshake 🤝
writing_hand ✍️|heart_hands 🫶|open_hands 👐|palms_up_together 🤲|fist 👊|facepunch 👊|punch 👊|the_horns 🤘|pinched_fingers 🤌
eyes 👀|eye 👁️|brain 🧠|bow 🙇|raising_hand 🙋|shrug 🤷|man-shrugging 🤷‍♂️|woman-shrugging 🤷‍♀️|facepalm 🤦|man-facepalming 🤦‍♂️
woman-facepalming 🤦‍♀️|person_frowning 🙍|technologist 🧑‍💻|ninja 🥷|detective 🕵️|superhero 🦸|mage 🧙|zombie 🧟|man_dancing 🕺|dancer 💃
smile 😄|smiley 😃|grinning 😀|grin 😁|laughing 😆|satisfied 😆|joy 😂|rolling_on_the_floor_laughing 🤣|rofl 🤣|sweat_smile 😅
slightly_smiling_face 🙂|simple_smile 🙂|upside_down_face 🙃|wink 😉|blush 😊|innocent 😇|heart_eyes 😍|star-struck 🤩|kissing_heart 😘
relaxed ☺️|yum 😋|stuck_out_tongue 😛|stuck_out_tongue_winking_eye 😜|zany_face 🤪|money_mouth_face 🤑|hugging_face 🤗|hugs 🤗
face_with_hand_over_mouth 🤭|shushing_face 🤫|thinking_face 🤔|thinking 🤔|saluting_face 🫡|zipper_mouth_face 🤐|face_with_raised_eyebrow 🤨
neutral_face 😐|expressionless 😑|no_mouth 😶|smirk 😏|unamused 😒|face_with_rolling_eyes 🙄|roll_eyes 🙄|grimacing 😬|lying_face 🤥
relieved 😌|pensive 😔|sleepy 😪|drooling_face 🤤|sleeping 😴|mask 😷|face_with_thermometer 🤒|nauseated_face 🤢|face_vomiting 🤮
sneezing_face 🤧|hot_face 🥵|cold_face 🥶|woozy_face 🥴|dizzy_face 😵|exploding_head 🤯|cowboy_hat_face 🤠|partying_face 🥳|sunglasses 😎
nerd_face 🤓|face_with_monocle 🧐|confused 😕|worried 😟|slightly_frowning_face 🙁|white_frowning_face ☹️|open_mouth 😮|hushed 😯
astonished 😲|flushed 😳|pleading_face 🥺|frowning 😦|anguished 😧|fearful 😨|cold_sweat 😰|disappointed_relieved 😥|cry 😢|sob 😭
scream 😱|confounded 😖|persevere 😣|disappointed 😞|sweat 😓|weary 😩|tired_face 😫|yawning_face 🥱|triumph 😤|rage 😡|angry 😠
face_with_symbols_on_mouth 🤬|smiling_imp 😈|skull 💀|skull_and_crossbones ☠️|poop 💩|hankey 💩|clown_face 🤡|ghost 👻|alien 👽
robot_face 🤖|robot 🤖|melting_face 🫠|face_holding_back_tears 🥹|dotted_line_face 🫥|face_with_peeking_eye 🫣|see_no_evil 🙈
hear_no_evil 🙉|speak_no_evil 🙊|smile_cat 😸|joy_cat 😹|heart_eyes_cat 😻|scream_cat 🙀
heart ❤️|red_heart ❤️|orange_heart 🧡|yellow_heart 💛|green_heart 💚|blue_heart 💙|purple_heart 💜|black_heart 🖤|white_heart 🤍
broken_heart 💔|two_hearts 💕|sparkling_heart 💖|heartpulse 💗|heart_on_fire ❤️‍🔥|100 💯|boom 💥|collision 💥|sparkles ✨|star ⭐
star2 🌟|dizzy 💫|zap ⚡|fire 🔥|tada 🎉|confetti_ball 🎊|balloon 🎈|gift 🎁|trophy 🏆|medal 🏅|sports_medal 🏅|first_place_medal 🥇
second_place_medal 🥈|third_place_medal 🥉|dart 🎯|checkered_flag 🏁|triangular_flag_on_post 🚩|crown 👑|gem 💎|rocket 🚀|airplane ✈️
white_check_mark ✅|heavy_check_mark ✔️|ballot_box_with_check ☑️|x ❌|negative_squared_cross_mark ❎|heavy_multiplication_x ✖️
warning ⚠️|no_entry ⛔|no_entry_sign 🚫|stop_sign 🛑|construction 🚧|rotating_light 🚨|question ❓|grey_question ❔|exclamation ❗
heavy_exclamation_mark ❗|grey_exclamation ❕|bangbang ‼️|interrobang ⁉️|heavy_plus_sign ➕|heavy_minus_sign ➖|arrow_right ➡️
arrow_left ⬅️|arrow_up ⬆️|arrow_down ⬇️|arrow_upper_right ↗️|arrow_lower_right ↘️|arrow_forward ▶️|arrows_counterclockwise 🔄
repeat 🔁|recycle ♻️|new 🆕|free 🆓|up 🆙|cool 🆒|ok 🆗|sos 🆘|red_circle 🔴|large_orange_circle 🟠|large_yellow_circle 🟡
large_green_circle 🟢|large_blue_circle 🔵|large_purple_circle 🟣|white_circle ⚪|black_circle ⚫|green_circle 🟢|yellow_circle 🟡
blue_circle 🔵|orange_circle 🟠|red_square 🟥|green_square 🟩|yellow_square 🟨|white_large_square ⬜|black_large_square ⬛
bulb 💡|memo 📝|pencil 📝|pencil2 ✏️|pushpin 📌|round_pushpin 📍|paperclip 📎|link 🔗|lock 🔒|unlock 🔓|key 🔑|closed_lock_with_key 🔐
bug 🐛|wrench 🔧|hammer 🔨|hammer_and_wrench 🛠️|gear ⚙️|nut_and_bolt 🔩|toolbox 🧰|test_tube 🧪|microscope 🔬|telescope 🔭
satellite 📡|magnet 🧲|battery 🔋|electric_plug 🔌|computer 💻|desktop_computer 🖥️|keyboard ⌨️|iphone 📱|phone ☎️|telephone_receiver 📞
email 📧|envelope ✉️|incoming_envelope 📨|inbox_tray 📥|outbox_tray 📤|package 📦|mailbox 📫|books 📚|book 📖|notebook 📓
page_facing_up 📄|page_with_curl 📃|clipboard 📋|file_folder 📁|open_file_folder 📂|card_index_dividers 🗂️|scissors ✂️|mag 🔍
mag_right 🔎|bookmark 🔖|label 🏷️|moneybag 💰|dollar 💵|money_with_wings 💸|chart_with_upwards_trend 📈|chart_with_downwards_trend 📉
bar_chart 📊|calendar 📆|date 📅|spiral_calendar_pad 🗓️|alarm_clock ⏰|stopwatch ⏱️|timer_clock ⏲️|watch ⌚|hourglass ⌛
hourglass_flowing_sand ⏳|bell 🔔|no_bell 🔕|mega 📣|loudspeaker 📢|speech_balloon 💬|thought_balloon 💭|left_speech_bubble 🗨️|zzz 💤
sweat_drops 💦|droplet 💧|dash 💨|hole 🕳️|bomb 💣|pill 💊|syringe 💉|dna 🧬|crystal_ball 🔮|game_die 🎲|jigsaw 🧩|art 🎨|movie_camera 🎥
camera 📷|tv 📺|musical_note 🎵|notes 🎶|headphones 🎧|microphone 🎤|guitar 🎸|video_game 🎮|soccer ⚽|basketball 🏀|football 🏈
coffee ☕|tea 🍵|beer 🍺|beers 🍻|wine_glass 🍷|clinking_glasses 🥂|pizza 🍕|hamburger 🍔|taco 🌮|burrito 🌯|popcorn 🍿|doughnut 🍩
cookie 🍪|cake 🍰|birthday 🎂|ice_cream 🍨|apple 🍎|banana 🍌|avocado 🥑|hot_pepper 🌶️|bread 🍞|cheese_wedge 🧀|egg 🥚|bacon 🥓
sunny ☀️|cloud ☁️|partly_sunny ⛅|rain_cloud 🌧️|umbrella ☂️|snowflake ❄️|snowman ⛄|rainbow 🌈|ocean 🌊|volcano 🌋|earth_americas 🌎
earth_africa 🌍|earth_asia 🌏|globe_with_meridians 🌐|world_map 🗺️|moon 🌙|crescent_moon 🌙|full_moon 🌕|new_moon 🌑|sun_with_face 🌞
house 🏠|office 🏢|hospital 🏥|bank 🏦|school 🏫|factory 🏭|tent ⛺|car 🚗|taxi 🚕|bus 🚌|train 🚆|bike 🚲|ship 🚢|anchor ⚓
seedling 🌱|herb 🌿|four_leaf_clover 🍀|cactus 🌵|palm_tree 🌴|evergreen_tree 🌲|deciduous_tree 🌳|fallen_leaf 🍂|maple_leaf 🍁
sunflower 🌻|rose 🌹|tulip 🌷|cherry_blossom 🌸|bouquet 💐|mushroom 🍄|dog 🐶|dog2 🐕|cat 🐱|cat2 🐈|mouse 🐭|hamster 🐹|rabbit 🐰
fox_face 🦊|bear 🐻|panda_face 🐼|koala 🐨|tiger 🐯|lion_face 🦁|cow 🐮|pig 🐷|frog 🐸|monkey_face 🐵|monkey 🐒|chicken 🐔|penguin 🐧
bird 🐦|baby_chick 🐤|duck 🦆|eagle 🦅|owl 🦉|bat 🦇|wolf 🐺|horse 🐴|racehorse 🐎|unicorn_face 🦄|unicorn 🦄|bee 🐝|honeybee 🐝
beetle 🪲|ladybug 🐞|butterfly 🦋|snail 🐌|turtle 🐢|snake 🐍|lizard 🦎|t-rex 🦖|sauropod 🦕|dragon 🐉|octopus 🐙|crab 🦀|shrimp 🦐
fish 🐟|tropical_fish 🐠|blowfish 🐡|shark 🦈|dolphin 🐬|whale 🐳|whale2 🐋|elephant 🐘|giraffe_face 🦒|zebra_face 🦓|sloth 🦥
otter 🦦|llama 🦙|camel 🐫|goat 🐐|sheep 🐑|ram 🐏|paw_prints 🐾|feet 🐾`.trim().split(/[|\n]/).map((entry) => entry.trim().split(" ")));

const TONES = { "skin-tone-2": "\u{1F3FB}", "skin-tone-3": "\u{1F3FC}", "skin-tone-4": "\u{1F3FD}", "skin-tone-5": "\u{1F3FE}", "skin-tone-6": "\u{1F3FF}" };

// One `:name:` (with an optional `:skin-tone-N:`) as its character, or null when it isn't a standard emoji.
export function emojiFor(name, tone = "") {
  const base = EMOJI[name];
  if (!base) return null;
  return TONES[tone] ? base.replace(/️$/, "") + TONES[tone] : base;
}

// Every standard shortcode in plain text, outside `code`; custom ones stay as written.
export function emojify(text = "") {
  return text.split(/(`[^`]*`)/).map((part, index) => index % 2 ? part : part.replace(/:([a-z0-9_+-]+):(?::(skin-tone-[2-6]):)?/g, (match, name, tone) => emojiFor(name, tone) ?? match)).join("");
}
